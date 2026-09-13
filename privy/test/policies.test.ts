/** Privy policy tests — the second layer of control. */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ALLOWED_CALLS, QUORUM, buildAllPolicies, buildPolicy, selector } from '../src/policies.ts';
import type { Role } from '../src/policies.ts';
import { VAULT_ABI_FRAGMENT } from '../src/abi.ts';

const VAULT = '0x0DCd1Bf9A1b36cE34237eEaFef220932846BCD82';
const POLICY = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const TARGETS = { vault: VAULT, treasuryPolicy: POLICY, abi: VAULT_ABI_FRAGMENT };
const ROLES: readonly Role[] = ['OPERATOR', 'TREASURER', 'RISK_OFFICER'];

describe('selectors', () => {
  /**
   * These values come from `forge inspect ... methodIdentifiers` on the compiled
   * contracts. A Solidity suite checks them against the bytecode on every run; this test
   * locks down the TypeScript side, so that a signature edited here does not slip past
   * unnoticed.
   */
  test('match the compiled contracts', () => {
    assert.equal(selector('approve(bytes32)'), '0xa53a1adf');
    assert.equal(selector('commitBandParams(bytes32)'), '0x97b00759');
    assert.equal(
      selector('execute(bytes32,(address,address,uint128,uint128)[],bytes32)'),
      '0xfc8d9160',
    );
  });

  test('every selector is four bytes', () => {
    for (const signatures of Object.values(ALLOWED_CALLS)) {
      for (const s of signatures) assert.match(selector(s), /^0x[0-9a-f]{8}$/);
    }
  });
});

describe('separation of duties, second layer', () => {
  const policies = buildAllPolicies(TARGETS);

  /**
   * The contract already enforces separation of duties. Why restate it here?
   *
   * Because the two layers fail differently. The contract protects against an operator
   * attempting a forbidden action; the policy protects against a **compromised** key
   * signing something else entirely — a transfer to an arbitrary address, a call to a
   * foreign contract. The contract never sees those transactions and has no way to
   * prevent them.
   */
  test('no role can approve except the treasurer', () => {
    const approveSelector = selector('approve(bytes32)');
    for (const role of ROLES) {
      const allowed = ALLOWED_CALLS[role].map(selector);
      assert.equal(
        allowed.includes(approveSelector),
        role === 'TREASURER',
        `${role} and approval`,
      );
    }
  });

  test('the treasurer can do nothing but approve', () => {
    assert.equal(ALLOWED_CALLS.TREASURER.length, 1);
  });

  test('the risk officer does not target the vault', () => {
    const rule = policies.RISK_OFFICER.rules[0]!;
    const to = rule.conditions.find((c) => c.field === 'to');
    assert.equal(to?.value, POLICY);
  });

  test('operator and treasurer target the vault', () => {
    for (const role of ['OPERATOR', 'TREASURER'] as const) {
      const to = policies[role].rules[0]!.conditions.find((c) => c.field === 'to');
      assert.equal(to?.value, VAULT);
    }
  });
});

describe('policy shape', () => {
  const policies = buildAllPolicies(TARGETS);

  test('every policy ends with an explicit denial', () => {
    for (const role of ROLES) {
      const rules = policies[role].rules;
      const last = rules[rules.length - 1]!;
      assert.equal(last.action, 'DENY');
      assert.equal(last.conditions.length, 0, 'the final denial must be unconditional');
    }
  });

  /**
   * The condition everyone forgets. A wallet allowed to *call* a contract stays allowed
   * to **send** it value — and on Arc gas is USDC, so native value is money.
   */
  test('no role can transfer native value', () => {
    for (const role of ROLES) {
      const value = policies[role].rules[0]!.conditions.find((c) => c.field === 'value');
      assert.ok(value, `${role}: no value constraint`);
      assert.equal(value!.operator, 'eq');
      assert.equal(value!.value, '0');
    }
  });

  test('calldata is constrained and the ABI is supplied', () => {
    for (const role of ROLES) {
      const calldata = policies[role].rules[0]!.conditions.find(
        (c) => c.field_source === 'ethereum_calldata',
      );
      assert.ok(calldata, `${role}: no calldata constraint`);
      assert.ok(calldata!.abi, 'Privy requires an ABI to decode calldata');
      assert.deepEqual(calldata!.value, ALLOWED_CALLS[role].map(selector));
    }
  });

  test('the version and chain type are the ones the API expects', () => {
    for (const role of ROLES) {
      assert.equal(policies[role].version, '1.0');
      assert.equal(policies[role].chain_type, 'ethereum');
    }
  });

  test('changing the vault address changes the policy', () => {
    const other = buildPolicy('OPERATOR', { ...TARGETS, vault: POLICY });
    assert.notDeepEqual(other, policies.OPERATOR);
  });
});

describe('quorum', () => {
  /**
   * Only one role requires two keys: the treasurer. It is the most consequential action in
   * the system, and the only one worth slowing down. A quorum on the operator would weigh
   * down every fifteen-minute epoch without protecting anything the contract does not
   * already protect.
   */
  test('only the treasurer requires multiple signatures', () => {
    assert.ok(QUORUM.TREASURER.threshold > 1);
    assert.equal(QUORUM.OPERATOR.threshold, 1);
  });

  test('no threshold exceeds the number of keys', () => {
    for (const role of ROLES) {
      assert.ok(QUORUM[role].threshold <= QUORUM[role].keys, `${role}: impossible quorum`);
      assert.ok(QUORUM[role].threshold >= 1);
    }
  });
});
