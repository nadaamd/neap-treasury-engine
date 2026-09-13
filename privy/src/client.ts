/**
 * Minimal Privy REST client.
 *
 * `fetch` is built into Node 24: this client adds no dependency, like the rest of the
 * repository outside the CRE workflow. It covers only the three calls NEAP needs — create
 * a policy, create a wallet, read a wallet — rather than wrapping an entire API of which
 * a tenth would be used.
 */

import type { PolicyDocument } from './policies.ts';

const BASE_URL = 'https://api.privy.io/v1';

export interface Credentials {
  readonly appId: string;
  readonly appSecret: string;
}

export function credentialsFromEnv(env: Record<string, string | undefined>): Credentials {
  const appId = env.PRIVY_APP_ID;
  const appSecret = env.PRIVY_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error(
      'PRIVY_APP_ID and PRIVY_APP_SECRET are required. ' +
        'Get them from dashboard.privy.io, then put them in privy/.env',
    );
  }
  return { appId, appSecret };
}

/**
 * Base64 encoding without `Buffer`: `btoa` is a standard language function, whereas
 * `Buffer` belongs to Node and would require @types/node — a dependency this repository
 * does not have outside the CRE workflow.
 */
function toBase64(value: string): string {
  return btoa(value);
}

function headers(creds: Credentials): Record<string, string> {
  const basic = toBase64(`${creds.appId}:${creds.appSecret}`);
  return {
    Authorization: `Basic ${basic}`,
    'privy-app-id': creds.appId,
    'Content-Type': 'application/json',
  };
}

async function call<T>(
  creds: Credentials,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: headers(creds),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await response.text();
  if (!response.ok) {
    // The response body carries the exact reason for the refusal. Hiding it behind a
    // "request failed" would force replaying the call by hand to find it again.
    throw new Error(`Privy ${method} ${path} → ${response.status}: ${text}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export interface CreatedPolicy {
  readonly id: string;
}

export function createPolicy(
  creds: Credentials,
  policy: PolicyDocument,
): Promise<CreatedPolicy> {
  return call<CreatedPolicy>(creds, 'POST', '/policies', policy);
}

export interface CreatedWallet {
  readonly id: string;
  readonly address: string;
  readonly chain_type: string;
}

export interface WalletRequest {
  readonly chain_type: 'ethereum';
  readonly policy_ids?: readonly string[];
  readonly owner_id?: string;
}

export function createWallet(
  creds: Credentials,
  request: WalletRequest,
): Promise<CreatedWallet> {
  return call<CreatedWallet>(creds, 'POST', '/wallets', request);
}

export function getWallet(creds: Credentials, walletId: string): Promise<CreatedWallet> {
  return call<CreatedWallet>(creds, 'GET', `/wallets/${walletId}`);
}

export interface KeyQuorumRequest {
  readonly display_name: string;
  readonly public_keys: readonly string[];
  readonly authorization_threshold: number;
}

export interface CreatedKeyQuorum {
  readonly id: string;
}

/**
 * Key quorum — m signatures out of n.
 *
 * NEAP puts one in a single place: the treasurer's approval. It is the most consequential
 * action in the system, and the only one worth slowing down. A quorum on the operator
 * would weigh down every fifteen-minute epoch without protecting anything the contract
 * does not already protect.
 */
export function createKeyQuorum(
  creds: Credentials,
  request: KeyQuorumRequest,
): Promise<CreatedKeyQuorum> {
  return call<CreatedKeyQuorum>(creds, 'POST', '/key_quorums', request);
}
