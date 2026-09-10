/**
 * Fonction de décision — le corps du handler confidentiel (décisions D5 et D9).
 *
 * ─── Ce que cette fonction est ────────────────────────────────────────────────
 * Une **fonction pure** : mêmes entrées, mêmes sorties, aucune E/S, aucune horloge, aucun
 * aléa. Elle s'exécute indifféremment dans le handler TEE de Chainlink CRE ou dans un
 * runner local, ce qui rend le plan de repli gratuit — c'est le même code.
 *
 * ─── Pourquoi elle est courte ─────────────────────────────────────────────────
 * Tout ce qui est coûteux — résolution des bandes, calibration de la volatilité, du
 * shrinkage, de la queue — ne dépend que des *paramètres*, pas de l'*état*. Ce travail
 * est fait hors enclave et engagé on-chain par `bandParamsHash` (D5). Ne reste ici que
 * ce qui touche aux positions : comparer l'état aux bandes, mesurer le risque, produire
 * un plan. C'est ce découpage qui rend la confidentialité énonçable en une phrase.
 *
 * ─── Pourquoi il n'y a qu'une seule règle de décision ─────────────────────────
 * La spec avait initialement deux règles concurrentes : la bande, et un critère
 * coût/bénéfice sur la VaR. Elles pouvaient se contredire. La bande n'est pas une entrée
 * du système, c'est le **résultat** de la minimisation de J — laquelle contient déjà le
 * portage, le coût fixe, le coût variable, le risque de change et le risque de rupture.
 * Rajouter ici un second filtre économique reviendrait à facturer deux fois les mêmes
 * arbitrages. La décision en ligne est donc volontairement triviale : hors bande, on
 * ramène à la cible. Toute l'intelligence est dans le calcul des bandes.
 */

import type { Currency } from '../../../data/src/types.ts';
import type { Bands } from '../bands/millerOrr.ts';
import { executionCost } from '../bands/simulate.ts';
import type { CostParams } from '../bands/simulate.ts';
import { conditionalCovariance } from '../risk/conditional.ts';
import { filteredHistoricalES, normalVaR, portfolioSigma, Z_99 } from '../risk/measures.ts';

export type DecisionStatus = 'NOOP' | 'PROPOSE' | 'REJECTED';

export interface Order {
  /** Devise cédée. */
  readonly sell: Currency;
  /** Devise acquise. */
  readonly buy: Currency;
  /** Montant en équivalent numéraire, déjà quantifié. */
  readonly amount: number;
}

/** Engagement connu à venir. Un engagement *certain* ampute le solde disponible ; un
 *  engagement probable ne fait que déformer la distribution et n'est pas déduit ici. */
export interface Commitment {
  readonly currency: Currency;
  readonly amount: number;
  readonly dueEpoch: number;
  readonly certain: boolean;
}

export interface CurrencyPolicy {
  readonly bands: Bands;
  readonly costs: CostParams;
  /** Plafond par ordre unitaire. */
  readonly maxSingleOrder: number;
  /** Délai de règlement du rail, en jours — un rail lent laisse l'exposition ouverte plus longtemps. */
  readonly settlementDays: number;
}

export interface RiskParams {
  readonly horizonDays: number;
  readonly alpha: number;
  readonly basisHaircutBps: number;
  /** Pas de quantification des ordres (D6). */
  readonly lotSize: number;
  /** En deçà, un ordre est de la poussière et n'est pas émis. */
  readonly minOrder: number;
  /** Au-delà, l'approbation humaine est requise. */
  readonly autoApproveThreshold: number;
  /** Plafond de notionnel cumulé sur l'epoch. */
  readonly maxPerEpoch: number;
  /** Solde minimal à préserver dans la devise de financement. */
  readonly fundingFloor: number;
  /** Âge maximal toléré pour les données de marché, en secondes. */
  readonly maxStalenessSec: number;
}

export interface DecisionInput {
  readonly epoch: number;
  readonly nonce: number;
  readonly policyVersion: number;
  readonly bandParamsHash: string;

  /** Devise de financement, numéraire du système. */
  readonly numeraire: Currency;
  /** Devises portant une bande, hors numéraire. */
  readonly currencies: readonly Currency[];

  /** — état confidentiel — */
  readonly balances: Readonly<Record<string, number>>;
  readonly commitments: readonly Commitment[];

  /** — paramètres, engagés on-chain par bandParamsHash — */
  readonly policies: Readonly<Record<string, CurrencyPolicy>>;
  readonly risk: RiskParams;

  /** — marché, public — */
  readonly currentVol: readonly number[];
  readonly residuals: readonly (readonly number[])[];
  readonly marketTimestamp: number;
  readonly now: number;
}

export interface DecisionMetrics {
  /** ES rapportée à l'exposition brute, en points de base — jamais en montant (D6). */
  readonly esBeforeBps: number;
  readonly esAfterBps: number;
  readonly var99BeforeBps: number;
  readonly var99AfterBps: number;
  /** Risque d'exécution : ES sur la durée de règlement des ordres, en points de base. */
  readonly settlementRiskBps: number;
  readonly costEstimate: number;
}

export interface Decision {
  readonly status: DecisionStatus;
  readonly reason: string;
  readonly orders: readonly Order[];
  readonly requiresApproval: boolean;
  readonly metrics: DecisionMetrics;
  /** Encodage canonique des ordres — le hachage est fait à la frontière, pas ici. */
  readonly ordersCanonical: string;
  readonly epoch: number;
  readonly nonce: number;
  readonly policyVersion: number;
  readonly bandParamsHash: string;
}

const EMPTY_METRICS: DecisionMetrics = {
  esBeforeBps: 0,
  esAfterBps: 0,
  var99BeforeBps: 0,
  var99AfterBps: 0,
  settlementRiskBps: 0,
  costEstimate: 0,
};

/** Quantification vers le bas sur le pas de lot — jamais vers le haut : on ne veut pas
 *  qu'un arrondi fasse franchir un plafond. */
function quantize(amount: number, lot: number): number {
  if (lot <= 0) return amount;
  return Math.floor(amount / lot) * lot;
}

/** Encodage canonique, stable et indépendant de l'ordre d'itération. */
export function canonicalizeOrders(orders: readonly Order[]): string {
  return orders
    .map((o) => `${o.sell}>${o.buy}:${o.amount}`)
    .sort()
    .join('|');
}

export function decide(input: DecisionInput): Decision {
  const {
    epoch,
    nonce,
    policyVersion,
    bandParamsHash,
    numeraire,
    currencies,
    balances,
    commitments,
    policies,
    risk,
  } = input;

  const envelope = { epoch, nonce, policyVersion, bandParamsHash };

  // 1. Fraîcheur des données de marché. Le contrat refera ce contrôle, mais décider sur
  //    des prix périmés puis se faire rejeter gaspille un epoch.
  const ageSec = (input.now - input.marketTimestamp) / 1000;
  if (ageSec > risk.maxStalenessSec || ageSec < 0) {
    return {
      status: 'REJECTED',
      reason: `données de marché périmées : ${ageSec.toFixed(0)} s > ${risk.maxStalenessSec} s`,
      orders: [],
      requiresApproval: false,
      metrics: EMPTY_METRICS,
      ordersCanonical: '',
      ...envelope,
    };
  }

  // 2. Solde disponible : on retranche les engagements certains échus dans l'horizon.
  //    Les engagements probables ne sont pas déduits — ils sont déjà dans la distribution
  //    de flux qui a servi à calculer les bandes.
  const available: Record<string, number> = {};
  for (const c of [numeraire, ...currencies]) available[c] = balances[c] ?? 0;
  for (const k of commitments) {
    if (k.certain && k.dueEpoch <= epoch + 1) {
      available[k.currency] = (available[k.currency] ?? 0) - k.amount;
    }
  }

  // 3. Écart aux bandes. Seule règle de décision du système.
  const raw: { currency: Currency; delta: number }[] = [];
  for (const c of currencies) {
    const policy = policies[c];
    if (!policy) continue;
    const b = available[c]!;
    if (b < policy.bands.lower) raw.push({ currency: c, delta: policy.bands.target - b });
    else if (b > policy.bands.upper) raw.push({ currency: c, delta: policy.bands.target - b });
  }

  // 4. Quantification, poussière, plafond unitaire.
  let candidates = raw
    .map(({ currency, delta }) => {
      const policy = policies[currency]!;
      const sign = Math.sign(delta);
      const capped = Math.min(Math.abs(delta), policy.maxSingleOrder);
      return { currency, signed: sign * quantize(capped, risk.lotSize) };
    })
    .filter((o) => Math.abs(o.signed) >= risk.minOrder);

  // 5. Contrainte de financement : on ne peut acheter que ce que le numéraire permet,
  //    plancher préservé. Les achats sont réduits au prorata, les ventes ne le sont pas
  //    puisqu'elles reconstituent le numéraire.
  const buys = candidates.filter((o) => o.signed > 0);
  const sells = candidates.filter((o) => o.signed < 0);
  const proceeds = sells.reduce((a, o) => a - o.signed, 0);
  const needed = buys.reduce((a, o) => a + o.signed, 0);
  const spendable = Math.max(0, (available[numeraire] ?? 0) + proceeds - risk.fundingFloor);

  let fundingScale = 1;
  if (needed > spendable && needed > 0) fundingScale = spendable / needed;

  // 6. Plafond de notionnel sur l'epoch.
  const grossAfterFunding = needed * fundingScale + proceeds;
  const epochScale =
    grossAfterFunding > risk.maxPerEpoch && grossAfterFunding > 0
      ? risk.maxPerEpoch / grossAfterFunding
      : 1;

  candidates = candidates
    .map((o) => ({
      currency: o.currency,
      signed: quantize(
        Math.abs(o.signed) * (o.signed > 0 ? fundingScale : 1) * epochScale,
        risk.lotSize,
      ) * Math.sign(o.signed),
    }))
    .filter((o) => Math.abs(o.signed) >= risk.minOrder);

  const orders: Order[] = candidates.map((o) =>
    o.signed > 0
      ? { sell: numeraire, buy: o.currency, amount: o.signed }
      : { sell: o.currency, buy: numeraire, amount: -o.signed },
  );

  // 7. Mesure du risque avant et après. L'exposition d'une devise, c'est son solde :
  //    un pré-financement non couvert *est* une position directionnelle subie.
  const before = currencies.map((c) => available[c] ?? 0);
  const after = before.slice();
  candidates.forEach((o) => {
    const i = currencies.indexOf(o.currency);
    if (i >= 0) after[i] = after[i]! + o.signed;
  });

  const { sigma } = conditionalCovariance(input.residuals, input.currentVol);
  const grossBefore = before.reduce((a, x) => a + Math.abs(x), 0);
  const toBps = (value: number, base: number) => (base > 0 ? Math.round((value / base) * 10_000) : 0);

  const esOf = (w: number[], horizonDays: number) =>
    filteredHistoricalES({
      residuals: input.residuals,
      currentVol: input.currentVol,
      weights: w,
      horizonDays,
      alpha: risk.alpha,
    }).es;

  const esBefore = esOf(before, risk.horizonDays);
  const esAfter = esOf(after, risk.horizonDays);
  const varBefore = normalVaR(portfolioSigma(before, sigma), risk.horizonDays, Z_99);
  const varAfter = normalVaR(portfolioSigma(after, sigma), risk.horizonDays, Z_99);

  // Risque d'exécution : chaque ordre reste exposé jusqu'à son règlement. Un rail lent
  // (J+2) porte donc un risque bien supérieur à un rail à finalité sub-seconde, à
  // montant égal — c'est le coût caché du corridor sans stablecoin.
  let settlementRisk = 0;
  for (const o of candidates) {
    const policy = policies[o.currency]!;
    const leg = currencies.map((c) => (c === o.currency ? Math.abs(o.signed) : 0));
    settlementRisk += esOf(leg, Math.max(policy.settlementDays, risk.horizonDays));
  }

  let costEstimate = 0;
  for (const o of candidates) {
    const policy = policies[o.currency]!;
    costEstimate += policy.costs.gammaFixed + executionCost(o.signed, policy.costs);
  }

  const gross = orders.reduce((a, o) => a + o.amount, 0);
  const metrics: DecisionMetrics = {
    esBeforeBps: toBps(esBefore, grossBefore),
    esAfterBps: toBps(esAfter, grossBefore),
    var99BeforeBps: toBps(varBefore, grossBefore),
    var99AfterBps: toBps(varAfter, grossBefore),
    settlementRiskBps: toBps(settlementRisk, grossBefore),
    costEstimate,
  };

  if (orders.length === 0) {
    return {
      status: 'NOOP',
      reason: 'tous les soldes disponibles sont à l’intérieur de leurs bandes',
      orders: [],
      requiresApproval: false,
      metrics,
      ordersCanonical: '',
      ...envelope,
    };
  }

  return {
    status: 'PROPOSE',
    reason:
      fundingScale < 1
        ? 'plan réduit par la contrainte de financement'
        : epochScale < 1
          ? 'plan réduit par le plafond de notionnel de l’epoch'
          : 'écart aux bandes',
    orders,
    requiresApproval: gross > risk.autoApproveThreshold,
    metrics,
    ordersCanonical: canonicalizeOrders(orders),
    ...envelope,
  };
}
