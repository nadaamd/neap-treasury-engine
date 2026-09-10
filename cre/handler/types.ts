/**
 * Contrat de données du handler confidentiel.
 *
 * La frontière tracée ici est celle de la décision D5 : ce qui dépend de l'**état** entre
 * dans l'enclave, ce qui ne dépend que des **paramètres** est calculé dehors et engagé
 * on-chain par empreinte. La séparation entre `TreasurySnapshot` et `MarketSnapshot` est
 * la matérialisation de cette frontière — l'un est un secret d'exploitation, l'autre est
 * public.
 */

import type { Currency } from '../../data/src/types.ts';
import type { Bands } from '../../engine/src/bands/millerOrr.ts';
import type { Commitment, CurrencyPolicy, RiskParams } from '../../engine/src/policy/decide.ts';

/**
 * Ce qui ne doit jamais sortir de l'enclave.
 *
 * Pris séparément, chacun de ces éléments est anodin. Publiés ensemble, ils dressent une
 * carte complète de la position de liquidité de l'institution — de quoi se positionner
 * contre elle. C'est cette conjonction, et non un élément isolé, qui justifie le TEE.
 */
export interface TreasurySnapshot {
  readonly epoch: number;
  readonly nonce: number;
  readonly balances: Readonly<Record<string, number>>;
  readonly commitments: readonly Commitment[];
  readonly policyVersion: number;
  readonly bandParamsHash: string;
  readonly bands: Readonly<Record<string, Bands>>;
  readonly limits: Readonly<Record<string, Omit<CurrencyPolicy, 'bands'>>>;
  readonly risk: RiskParams;
}

/** Ce qui peut rester dehors : prix, volatilité, gaz. Rien de tout cela n'est un secret. */
export interface MarketSnapshot {
  readonly timestamp: number;
  readonly currentVol: readonly number[];
  readonly residuals: readonly (readonly number[])[];
  /** Unités de jeton par unité de numéraire, par devise. */
  readonly rates: Readonly<Record<string, number>>;
  readonly gasUsdc: number;
}

/** Adresses des jetons et paramètres d'exécution — publics, fixés par la politique. */
export interface ChainConfig {
  readonly numeraire: Currency;
  readonly currencies: readonly Currency[];
  readonly tokens: Readonly<Record<string, string>>;
  /** Décimales communes à tous les jetons du périmètre. */
  readonly decimals: number;
  /** Tolérance de glissement appliquée au `minAmountOut` de chaque ordre. */
  readonly slippageBps: number;
  /** Durée de validité du rapport, en secondes. */
  readonly validitySec: number;
}

export interface HandlerInput {
  readonly treasury: TreasurySnapshot;
  readonly market: MarketSnapshot;
  readonly chain: ChainConfig;
  /**
   * Graine du sel d'engagement, obtenue par `runtime.getSecret` dans l'enclave.
   *
   * Le handler est une fonction pure : il n'a pas d'aléa. Or le sel doit être
   * imprévisible pour un observateur, sans quoi l'espace des plans quantifiés est assez
   * petit pour être exploré par force brute et l'engagement ne cache rien. Dériver le
   * sel d'un secret résout les deux contraintes à la fois — déterministe dans l'enclave,
   * imprévisible dehors.
   */
  readonly saltSeed: string;
  /** Horodatage fourni par le runtime : une fonction pure ne lit pas d'horloge. */
  readonly now: number;
}

export interface PlannedOrder {
  readonly sell: string;
  readonly buy: string;
  readonly amountIn: bigint;
  readonly minAmountOut: bigint;
}

export interface HandlerOutput {
  readonly status: 'NOOP' | 'PROPOSE' | 'REJECTED';
  readonly reason: string;
  /** Publié on-chain. Ne contient aucun montant par devise. */
  readonly report: {
    readonly epoch: bigint;
    readonly nonce: bigint;
    readonly expiry: bigint;
    readonly inputsTimestamp: bigint;
    readonly policyVersion: bigint;
    readonly bandParamsHash: string;
    readonly inputsHash: string;
    readonly ordersCommitment: string;
    readonly esBeforeBps: bigint;
    readonly esAfterBps: bigint;
    readonly costEstimate: bigint;
    readonly grossNotional: bigint;
  };
  /** Transmis à l'opérateur, jamais publié tant que le plan n'est pas exécuté. */
  readonly reveal: {
    readonly orders: readonly PlannedOrder[];
    readonly salt: string;
  };
}
