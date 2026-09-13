/**
 * Data contract of the confidential handler.
 *
 * The boundary drawn here is decision D5: what depends on **state** goes into the
 * enclave, what depends only on **parameters** is computed outside and committed on-chain
 * by hash. The split between `TreasurySnapshot` and `MarketSnapshot` is that boundary
 * made concrete — one is an operational secret, the other is public.
 */

import type { Currency } from '../../data/src/types.ts';
import type { Bands } from '../../engine/src/bands/millerOrr.ts';
import type { Commitment, CurrencyPolicy, RiskParams } from '../../engine/src/policy/decide.ts';

/**
 * What must never leave the enclave.
 *
 * Taken separately, each of these items is innocuous. Published together, they draw a
 * complete map of the institution's liquidity position — enough to trade against it. It
 * is that conjunction, not any single item, that justifies the TEE.
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

/** What can stay outside: prices, volatility, gas. None of it is a secret. */
export interface MarketSnapshot {
  readonly timestamp: number;
  readonly currentVol: readonly number[];
  readonly residuals: readonly (readonly number[])[];
  /** Token units per unit of numeraire, per currency. */
  readonly rates: Readonly<Record<string, number>>;
  readonly gasUsdc: number;
}

/** Token addresses and execution parameters — public, set by policy. */
export interface ChainConfig {
  readonly numeraire: Currency;
  readonly currencies: readonly Currency[];
  readonly tokens: Readonly<Record<string, string>>;
  /** Decimals shared by every token in scope. */
  readonly decimals: number;
  /** Slippage tolerance applied to each order's `minAmountOut`. */
  readonly slippageBps: number;
  /** Validity window of the report, in seconds. */
  readonly validitySec: number;
}

export interface HandlerInput {
  readonly treasury: TreasurySnapshot;
  readonly market: MarketSnapshot;
  readonly chain: ChainConfig;
  /**
   * Seed of the commitment salt, obtained through `runtime.getSecret` inside the enclave.
   *
   * The handler is a pure function: it has no randomness. Yet the salt must be
   * unpredictable to an observer, otherwise the space of quantised plans is small enough
   * to brute-force and the commitment hides nothing. Deriving the salt from a secret
   * satisfies both constraints at once — deterministic inside the enclave, unpredictable
   * outside.
   */
  readonly saltSeed: string;
  /** Timestamp supplied by the runtime: a pure function does not read a clock. */
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
  /** Published on-chain. Contains no per-currency amount. */
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
  /** Handed to the operator, never published until the plan is executed. */
  readonly reveal: {
    readonly orders: readonly PlannedOrder[];
    readonly salt: string;
  };
}
