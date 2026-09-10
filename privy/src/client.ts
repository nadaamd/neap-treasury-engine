/**
 * Client REST Privy minimal.
 *
 * `fetch` est intégré à Node 24 : ce client n'ajoute aucune dépendance, comme le reste
 * du dépôt hors du workflow CRE. Il ne couvre que les trois appels dont FLOAT a besoin —
 * créer une politique, créer un portefeuille, lire un portefeuille — plutôt que
 * d'envelopper une API entière dont on n'utiliserait qu'un dixième.
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
      'PRIVY_APP_ID et PRIVY_APP_SECRET sont requis. ' +
        'Les obtenir sur dashboard.privy.io, puis les placer dans privy/.env',
    );
  }
  return { appId, appSecret };
}

/**
 * Encodage base64 sans `Buffer` : `btoa` est une fonction standard du langage, tandis
 * que `Buffer` appartient à Node et exigerait @types/node — une dépendance que ce dépôt
 * n'a pas hors du workflow CRE.
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
    // Le corps de la réponse porte la raison exacte du refus. La masquer derrière un
    // « échec de la requête » obligerait à rejouer l'appel à la main pour la retrouver.
    throw new Error(`Privy ${method} ${path} → ${response.status} : ${text}`);
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
 * Quorum de clés — m signatures sur n.
 *
 * FLOAT n'en met qu'un seul endroit : l'approbation du trésorier. C'est le geste le plus
 * lourd de conséquences du système, et le seul dont le ralentissement soit justifié. Un
 * quorum sur l'opérateur alourdirait chaque epoch de quinze minutes sans rien protéger
 * que le contrat ne protège déjà.
 */
export function createKeyQuorum(
  creds: Credentials,
  request: KeyQuorumRequest,
): Promise<CreatedKeyQuorum> {
  return call<CreatedKeyQuorum>(creds, 'POST', '/key_quorums', request);
}
