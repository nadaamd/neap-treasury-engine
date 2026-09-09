/**
 * Mesures de risque de marché — décision D4.
 *
 * Trois estimateurs sont fournis et comparés, parce que l'écart entre eux *est* le
 * résultat intéressant :
 *
 *   • VaR normale         — le langage du métier, sert à l'affichage ;
 *   • ES normale          — cohérente, mais suppose la normalité ;
 *   • ES par FHS          — simulation historique filtrée, retenue pour la décision.
 *
 * Pourquoi 97,5 % pour l'ES et 99 % pour la VaR ? Parce que sous hypothèse gaussienne
 * ES_97,5 ≈ VaR_99 (2,338 σ contre 2,326 σ). Le comité de Bâle a choisi ce couple dans
 * FRTB précisément pour que le passage de la VaR à l'ES ne change pas le niveau de
 * capital sur des distributions normales — tout en rendant la mesure sensible à ce qui
 * se passe *au-delà* du quantile. L'écart entre les deux mesure donc l'épaisseur de la
 * queue, et rien d'autre. C'est un test que ce module vérifie.
 */

import { quadForm } from '../linalg.ts';
import type { Matrix, Vector } from '../linalg.ts';

/** Quantile normal à 99 %. */
export const Z_99 = 2.3263478740408408;
/** Quantile normal à 97,5 %. */
export const Z_975 = 1.959963984540054;

function normalPdf(z: number): number {
  return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
}

/** Multiplicateur d'ES gaussienne : φ(z_α) / (1 − α). */
export function normalEsFactor(alpha: number, z: number): number {
  return normalPdf(z) / (1 - alpha);
}

/** Volatilité du portefeuille : √(wᵀ Σ w). */
export function portfolioSigma(weights: Vector, sigma: Matrix): number {
  const v = quadForm(weights, sigma);
  return Math.sqrt(Math.max(v, 0));
}

/** VaR gaussienne, en montant, pour un horizon de `horizonDays` jours. */
export function normalVaR(sigmaP: number, horizonDays: number, z: number = Z_99): number {
  return z * sigmaP * Math.sqrt(horizonDays);
}

/** ES gaussienne, en montant. */
export function normalES(sigmaP: number, horizonDays: number, alpha = 0.975): number {
  const z = alpha === 0.975 ? Z_975 : Z_99;
  return normalEsFactor(alpha, z) * sigmaP * Math.sqrt(horizonDays);
}

export interface FhsInput {
  /**
   * Résidus standardisés z_{t,i} = r_{t,i} / σ_{t,i}, matrice T × n.
   * Les vecteurs transversaux sont conservés tels quels : c'est ce qui préserve la
   * corrélation empirique et la dépendance de queue entre devises. Rééchantillonner
   * chaque devise indépendamment détruirait exactement l'information qui compte.
   */
  readonly residuals: readonly (readonly number[])[];
  /** Volatilité conditionnelle courante par devise. */
  readonly currentVol: Vector;
  /** Exposition signée par devise, en numéraire. */
  readonly weights: Vector;
  readonly horizonDays: number;
  readonly alpha: number;
}

export interface FhsResult {
  readonly es: number;
  readonly var: number;
  /** Nombre de scénarios dans la queue effectivement moyennés. */
  readonly tailCount: number;
}

/**
 * Simulation historique filtrée.
 *
 * Le filtrage consiste à diviser les rendements passés par la volatilité qui régnait
 * alors, puis à remultiplier par la volatilité d'aujourd'hui. On réutilise donc la
 * *forme* de la distribution historique — ses queues, son asymétrie, sa dépendance
 * transversale — sans importer son niveau de volatilité, qui est périmé.
 *
 * C'est ce qui distingue la FHS de la simulation historique brute, laquelle sous-estime
 * le risque après une période calme et le surestime après une crise.
 */
export function filteredHistoricalES(input: FhsInput): FhsResult {
  const { residuals, currentVol, weights, horizonDays, alpha } = input;
  const scale = Math.sqrt(horizonDays);
  const losses: number[] = [];

  for (const z of residuals) {
    let pnl = 0;
    for (let i = 0; i < weights.length; i++) {
      pnl += weights[i]! * currentVol[i]! * z[i]! * scale;
    }
    losses.push(-pnl);
  }

  losses.sort((a, b) => b - a); // pertes décroissantes
  const tailCount = Math.max(1, Math.ceil(losses.length * (1 - alpha)));
  const tail = losses.slice(0, tailCount);
  const es = tail.reduce((a, b) => a + b, 0) / tailCount;
  return { es, var: losses[tailCount - 1]!, tailCount };
}

/**
 * Majoration pour risque de base stablecoin — SPEC §1.5.
 *
 * Couvrir une exposition EUR avec de l'EURC laisse un risque résiduel de décrochage du
 * peg, de défaut de l'émetteur et de liquidité de rachat. Ce risque est structurellement
 * invisible dans un historique court : le peg tient jusqu'au jour où il ne tient plus.
 * On le traite donc par une majoration forfaitaire assumée plutôt qu'en faisant semblant
 * qu'il n'existe pas.
 */
export function basisAddOn(exposures: Vector, haircutBps: number): number {
  const h = haircutBps / 10_000;
  return exposures.reduce((a, e) => a + Math.abs(e), 0) * h;
}

export interface RiskCapitalInput {
  readonly weights: Vector;
  readonly sigma: Matrix;
  readonly horizonDays: number;
  readonly fhs?: FhsInput;
  readonly basisHaircutBps: number;
}

export interface RiskCapital {
  readonly sigmaP: number;
  readonly var99Normal: number;
  readonly es975Normal: number;
  readonly es975Fhs: number | null;
  readonly basis: number;
  /** Capital de risque retenu pour la décision : ES (FHS si disponible) + base. */
  readonly total: number;
}

export function riskCapital(input: RiskCapitalInput): RiskCapital {
  const sigmaP = portfolioSigma(input.weights, input.sigma);
  const var99Normal = normalVaR(sigmaP, input.horizonDays, Z_99);
  const es975Normal = normalES(sigmaP, input.horizonDays, 0.975);
  const es975Fhs = input.fhs ? filteredHistoricalES(input.fhs).es : null;
  const basis = basisAddOn(input.weights, input.basisHaircutBps);
  const es = es975Fhs ?? es975Normal;
  return { sigmaP, var99Normal, es975Normal, es975Fhs, basis, total: es + basis };
}
