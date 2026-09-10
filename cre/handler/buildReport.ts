/**
 * Cœur du handler confidentiel : de l'état de trésorerie au rapport signable.
 *
 * Ce module ne connaît pas le SDK CRE. Il prend un état, rend un rapport — donc il se
 * teste sans enclave, sans réseau et sans chaîne. Le handler CRE proprement dit se
 * réduira à récupérer un secret, faire deux appels HTTP et appeler cette fonction.
 *
 * C'est la conséquence directe de D9 : le moteur est une fonction pure, portable telle
 * quelle. Ce fichier est l'adaptateur qui la relie au format de la chaîne, et il est
 * pur lui aussi.
 */

import { decide } from '../../engine/src/policy/decide.ts';
import type { DecisionInput } from '../../engine/src/policy/decide.ts';
import { ordersCommitment } from '../../engine/src/onchain/abi.ts';
import type { OnchainOrder } from '../../engine/src/onchain/abi.ts';
import { keccak256, toHex } from '../../engine/src/onchain/keccak.ts';
import type { Currency } from '../../data/src/types.ts';
import type { HandlerInput, HandlerOutput, PlannedOrder } from './types.ts';

const encoder = new TextEncoder();

/** Empreinte stable d'une valeur JSON, insensible à l'ordre d'énumération des clés. */
function stableHash(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort());
    }
    return v;
  });
  return toHex(keccak256(encoder.encode(canonical)));
}

/**
 * Sel dérivé, jamais tiré au hasard.
 *
 * Il doit être imprévisible pour un observateur — sinon l'engagement ne cache rien — et
 * reproductible dans l'enclave, puisqu'une fonction pure n'a pas d'aléa. Le dériver d'un
 * secret et du couple (epoch, nonce) satisfait les deux, et garantit au passage qu'aucun
 * sel n'est réutilisé d'un rapport à l'autre.
 */
export function deriveSalt(seed: string, epoch: number, nonce: number): string {
  return toHex(keccak256(encoder.encode(`${seed}|${epoch}|${nonce}`)));
}

function toUnits(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount < 0) throw new RangeError(`montant invalide : ${amount}`);
  return BigInt(Math.round(amount * 10 ** decimals));
}

export function buildReport(input: HandlerInput): HandlerOutput {
  const { treasury, market, chain, saltSeed, now } = input;

  const decisionInput: DecisionInput = {
    epoch: treasury.epoch,
    nonce: treasury.nonce,
    policyVersion: treasury.policyVersion,
    bandParamsHash: treasury.bandParamsHash,
    numeraire: chain.numeraire,
    currencies: chain.currencies,
    balances: treasury.balances,
    commitments: treasury.commitments,
    policies: Object.fromEntries(
      chain.currencies.map((c) => [c, { ...treasury.limits[c]!, bands: treasury.bands[c]! }]),
    ),
    risk: treasury.risk,
    currentVol: market.currentVol,
    residuals: market.residuals,
    marketTimestamp: market.timestamp,
    now,
    maxStalenessSec: treasury.risk.maxStalenessSec ?? 600,
  } as DecisionInput;

  const decision = decide(decisionInput);
  const salt = deriveSalt(saltSeed, treasury.epoch, treasury.nonce);

  // Les entrées publiques sont engagées séparément : le contrat ne peut pas les
  // vérifier, mais leur empreinte rend l'audit possible après coup.
  const inputsHash = stableHash({
    timestamp: market.timestamp,
    rates: market.rates,
    gasUsdc: market.gasUsdc,
    vol: market.currentVol,
  });

  const orders: PlannedOrder[] = [];
  for (const o of decision.orders) {
    const buysForeign = o.sell === chain.numeraire;
    const foreign = buysForeign ? o.buy : o.sell;
    const rate = market.rates[foreign];
    if (rate === undefined || rate <= 0) throw new RangeError(`taux manquant pour ${foreign}`);

    // Le moteur raisonne en équivalent numéraire ; la chaîne raisonne en unités de jeton.
    const keep = (10_000 - chain.slippageBps) / 10_000;
    const amountIn = buysForeign ? o.amount : o.amount * rate;
    const grossOut = buysForeign ? o.amount * rate : o.amount;

    orders.push({
      sell: chain.tokens[o.sell]!,
      buy: chain.tokens[o.buy]!,
      amountIn: toUnits(amountIn, chain.decimals),
      minAmountOut: toUnits(grossOut * keep, chain.decimals),
    });
  }

  /**
   * Le notionnel brut doit être calculé **exactement comme le coffre le recalcule** :
   * le montant entrant pour un achat, le montant sortant minimal pour une vente. Toute
   * autre convention ferait échouer l'exécution sur `NotionalMismatch`, après une
   * signature valide et une approbation humaine — le pire moment pour découvrir une
   * divergence de convention.
   */
  const grossNotional = orders.reduce(
    (a, o) => a + (o.sell === chain.tokens[chain.numeraire] ? o.amountIn : o.minAmountOut),
    0n,
  );

  const onchainOrders: OnchainOrder[] = orders.map((o) => ({
    sell: o.sell,
    buy: o.buy,
    amountIn: o.amountIn,
    minAmountOut: o.minAmountOut,
  }));

  const commitment =
    orders.length > 0 ? ordersCommitment(onchainOrders, salt) : `0x${'00'.repeat(32)}`;

  return {
    status: decision.status,
    reason: decision.reason,
    report: {
      epoch: BigInt(treasury.epoch),
      nonce: BigInt(treasury.nonce),
      expiry: BigInt(Math.floor(now / 1000) + chain.validitySec),
      inputsTimestamp: BigInt(Math.floor(market.timestamp / 1000)),
      policyVersion: BigInt(treasury.policyVersion),
      bandParamsHash: treasury.bandParamsHash,
      inputsHash,
      ordersCommitment: commitment,
      esBeforeBps: BigInt(decision.metrics.esBeforeBps),
      esAfterBps: BigInt(decision.metrics.esAfterBps),
      costEstimate: toUnits(decision.metrics.costEstimate, chain.decimals),
      grossNotional,
    },
    reveal: { orders, salt },
  };
}

/** Devises du périmètre, ré-exportées pour le handler. */
export type { Currency };
