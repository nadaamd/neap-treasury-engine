/**
 * Privy policies derived from NEAP's role model.
 *
 * ─── Why two layers of control ───────────────────────────────────────────────
 * Separation of duties is already enforced on-chain (D7): `TreasuryPolicy` refuses to let
 * one address hold both RISK_OFFICER and TREASURER, and the vault refuses an unapproved
 * execution. So why restate it at the wallet level?
 *
 * Because the two layers fail differently. The contract protects against an operator
 * attempting a forbidden action; the Privy policy protects against a **compromised key**
 * attempting something else entirely — signing a transfer to an arbitrary address,
 * calling a foreign contract, draining a balance. The contract never sees those
 * transactions; it has no way to prevent them.
 *
 * A stolen key passes authentication. It does not pass a policy that allows three
 * selectors towards two addresses.
 *
 * ─── What each layer can do ──────────────────────────────────────────────────
 *   contract  → who may do what, and within which amount limits
 *   Privy     → which transactions this key may sign at all
 *
 * Neither replaces the other.
 */

import { keccak256Hex } from '../../engine/src/onchain/keccak.ts';

export type Role = 'OPERATOR' | 'TREASURER' | 'RISK_OFFICER';

/** Function selector: the first four bytes of the keccak of the signature. */
export function selector(signature: string): string {
  return keccak256Hex(signature).slice(0, 10);
}

/**
 * What each role may sign.
 *
 * The list is deliberately short. A role that can call four functions on two contracts is
 * a role whose worst case can be reasoned about.
 */
export const ALLOWED_CALLS: Readonly<Record<Role, readonly string[]>> = {
  // The operator submits and executes. It can neither approve nor touch the limits.
  OPERATOR: [
    'submit((uint64,uint64,uint64,uint64,uint32,bytes32,bytes32,bytes32,int32,int32,uint128,uint128),bytes,bytes[])',
    'execute(bytes32,(address,address,uint128,uint128)[],bytes32)',
  ],
  // The treasurer has a single action: approve. It is the most sensitive role and the
  // one with the narrowest surface.
  TREASURER: ['approve(bytes32)'],
  // The risk officer queues changes. It executes nothing — even applying a matured
  // change is open to anyone, because it is not a power.
  RISK_OFFICER: [
    'queueCurrencyPolicy(address,(uint128,uint128,uint128,uint128,uint128,uint128))',
    'queueRiskParams((uint32,uint32,uint32,uint32,uint32,uint128))',
    'commitBandParams(bytes32)',
  ],
} as const;

export interface PolicyCondition {
  readonly field_source: 'ethereum_transaction' | 'ethereum_calldata';
  readonly field: string;
  readonly operator: 'eq' | 'lte' | 'in';
  readonly value: unknown;
  readonly abi?: unknown;
}

export interface PolicyRule {
  readonly name: string;
  readonly method: 'eth_sendTransaction';
  readonly action: 'ALLOW' | 'DENY';
  readonly conditions: readonly PolicyCondition[];
}

export interface PolicyDocument {
  readonly version: '1.0';
  readonly name: string;
  readonly chain_type: 'ethereum';
  readonly rules: readonly PolicyRule[];
}

export interface PolicyTargets {
  readonly vault: string;
  readonly treasuryPolicy: string;
  /** Minimal ABI used by Privy to decode calldata. */
  readonly abi: readonly unknown[];
}

/**
 * The calldata field carrying the name of the called function.
 *
 * ⚠️ To be confirmed at the first real provisioning: the documentation establishes that
 * `field_source: 'ethereum_calldata'` exists and that an ABI must be supplied, without
 * fixing the field name. It is isolated here rather than scattered — if the API rejects
 * it, it will say so, and a single constant changes.
 */
export const CALLDATA_FUNCTION_FIELD = 'function';

function targetOf(role: Role, targets: PolicyTargets): string {
  return role === 'RISK_OFFICER' ? targets.treasuryPolicy : targets.vault;
}

/**
 * Builds the policy for a role.
 *
 * Three cumulative conditions: the destination, the function, and the absence of native
 * value transfer. The third is the one that gets forgotten — a wallet allowed to call a
 * contract stays allowed to **send** it gas, and on Arc gas is USDC.
 */
export function buildPolicy(role: Role, targets: PolicyTargets): PolicyDocument {
  const to = targetOf(role, targets);
  const selectors = ALLOWED_CALLS[role].map(selector);

  return {
    version: '1.0',
    name: `NEAP — ${role}`,
    chain_type: 'ethereum',
    rules: [
      {
        name: `${role}: allowed calls`,
        method: 'eth_sendTransaction',
        action: 'ALLOW',
        conditions: [
          { field_source: 'ethereum_transaction', field: 'to', operator: 'eq', value: to },
          {
            field_source: 'ethereum_calldata',
            field: CALLDATA_FUNCTION_FIELD,
            operator: 'in',
            value: selectors,
            abi: targets.abi,
          },
          // On Arc, gas is USDC: a wallet allowed to call a contract would stay allowed
          // to transfer value to it unless this is said explicitly.
          { field_source: 'ethereum_transaction', field: 'value', operator: 'eq', value: '0' },
        ],
      },
      {
        // Explicit denial at the end of the list. A policy that allows three calls
        // without denying the rest depends on the engine's evaluation order — better not
        // to depend on it.
        name: `${role}: everything else is denied`,
        method: 'eth_sendTransaction',
        action: 'DENY',
        conditions: [],
      },
    ],
  };
}

export function buildAllPolicies(targets: PolicyTargets): Record<Role, PolicyDocument> {
  return {
    OPERATOR: buildPolicy('OPERATOR', targets),
    TREASURER: buildPolicy('TREASURER', targets),
    RISK_OFFICER: buildPolicy('RISK_OFFICER', targets),
  };
}

/**
 * Quorum threshold per role.
 *
 * The treasurer approves movements above the auto-approval threshold: the most
 * consequential action in the system, hence the only one requiring two keys. A quorum on
 * the operator would slow down every epoch without protecting anything the contract does
 * not already protect.
 */
export const QUORUM: Readonly<Record<Role, { threshold: number; keys: number }>> = {
  OPERATOR: { threshold: 1, keys: 1 },
  TREASURER: { threshold: 2, keys: 3 },
  RISK_OFFICER: { threshold: 1, keys: 2 },
};
