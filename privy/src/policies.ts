/**
 * Politiques Privy dérivées du modèle de rôles de NEAP.
 *
 * ─── Pourquoi deux couches de contrôle ───────────────────────────────────────
 * La séparation des devoirs est déjà imposée on-chain (D7) : `TreasuryPolicy` refuse
 * qu'une même adresse détienne à la fois RISK_OFFICER et TREASURER, et le coffre refuse
 * une exécution non approuvée. Alors pourquoi la redire côté portefeuille ?
 *
 * Parce que les deux couches échouent différemment. Le contrat protège contre un
 * opérateur qui tenterait une action interdite ; la politique Privy protège contre une
 * **clé compromise** qui tenterait autre chose — signer un transfert vers une adresse
 * arbitraire, appeler un contrat étranger, vider un solde. Le contrat ne voit jamais ces
 * transactions-là ; il n'a aucun moyen de les empêcher.
 *
 * Une clé volée passe l'authentification. Elle ne passe pas une politique qui n'autorise
 * que trois sélecteurs vers deux adresses.
 *
 * ─── Ce que chaque couche sait faire ─────────────────────────────────────────
 *   contrat   → qui a le droit de faire quoi, et dans quelles limites de montant
 *   Privy     → quelles transactions cette clé peut signer, tout court
 *
 * Aucune des deux ne remplace l'autre.
 */

import { keccak256Hex } from '../../engine/src/onchain/keccak.ts';

export type Role = 'OPERATOR' | 'TREASURER' | 'RISK_OFFICER';

/** Sélecteur de fonction : les quatre premiers octets du keccak de la signature. */
export function selector(signature: string): string {
  return keccak256Hex(signature).slice(0, 10);
}

/**
 * Ce que chaque rôle a le droit de signer.
 *
 * La liste est délibérément courte. Un rôle qui peut appeler quatre fonctions sur deux
 * contrats est un rôle dont on peut raisonner sur le pire cas.
 */
export const ALLOWED_CALLS: Readonly<Record<Role, readonly string[]>> = {
  // L'opérateur soumet et exécute. Il ne peut ni approuver, ni toucher aux limites.
  OPERATOR: [
    'submit((uint64,uint64,uint64,uint64,uint32,bytes32,bytes32,bytes32,int32,int32,uint128,uint128),bytes,bytes[])',
    'execute(bytes32,(address,address,uint128,uint128)[],bytes32)',
  ],
  // Le trésorier n'a qu'un seul geste : approuver. C'est le rôle le plus sensible et
  // c'est celui dont la surface est la plus étroite.
  TREASURER: ['approve(bytes32)'],
  // Le responsable des risques met des changements en file. Il n'exécute rien — même
  // l'application d'un changement mûr est ouverte à tous, parce qu'elle n'est pas un
  // pouvoir.
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
  /** ABI minimale servant à Privy pour décoder la calldata. */
  readonly abi: readonly unknown[];
}

/**
 * Le champ de la calldata portant le nom de la fonction appelée.
 *
 * ⚠️ À confirmer au premier provisionnement réel : la documentation établit l'existence
 * de `field_source: 'ethereum_calldata'` et l'obligation de fournir une ABI, sans figer
 * le nom du champ. On l'isole ici plutôt que de le disséminer — si l'API le refuse, elle
 * le dira, et une seule constante changera.
 */
export const CALLDATA_FUNCTION_FIELD = 'function';

function targetOf(role: Role, targets: PolicyTargets): string {
  return role === 'RISK_OFFICER' ? targets.treasuryPolicy : targets.vault;
}

/**
 * Construit la politique d'un rôle.
 *
 * Trois conditions cumulatives : la destination, la fonction, et l'absence de transfert
 * de valeur native. La troisième est celle qu'on oublie — un portefeuille autorisé à
 * appeler un contrat reste autorisé à lui **envoyer** du gaz, et sur Arc le gaz est de
 * l'USDC.
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
        name: `${role} : appels autorisés`,
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
          // Sur Arc le gaz est de l'USDC : un portefeuille autorisé à appeler un contrat
          // resterait autorisé à lui transférer de la valeur si on ne le disait pas.
          { field_source: 'ethereum_transaction', field: 'value', operator: 'eq', value: '0' },
        ],
      },
      {
        // Refus explicite en fin de liste. Une politique qui n'autorise que trois appels
        // sans refuser le reste dépend de l'ordre d'évaluation du moteur — mieux vaut ne
        // pas en dépendre.
        name: `${role} : tout le reste est refusé`,
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
 * Seuil de quorum par rôle.
 *
 * Le trésorier approuve les mouvements au-delà du seuil d'auto-approbation : c'est le
 * geste le plus lourd de conséquences du système, donc le seul à exiger deux clés. Un
 * quorum sur l'opérateur ralentirait chaque epoch sans rien protéger que le contrat ne
 * protège déjà.
 */
export const QUORUM: Readonly<Record<Role, { threshold: number; keys: number }>> = {
  OPERATOR: { threshold: 1, keys: 1 },
  TREASURER: { threshold: 2, keys: 3 },
  RISK_OFFICER: { threshold: 1, keys: 2 },
};
