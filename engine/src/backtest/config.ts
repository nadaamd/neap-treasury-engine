/**
 * Paramètres du backtest.
 *
 * Toutes les valeurs sont visibles ici plutôt que disséminées : un résultat chiffré ne
 * vaut que si l'on peut lire d'un coup d'œil sous quelles hypothèses il a été obtenu.
 */

import type { Currency } from '../../../data/src/types.ts';
import type { CurrencyCosts } from './types.ts';

export const EPOCHS_PER_DAY = 96;
export const EPOCH_MS = 15 * 60 * 1000;
export const DAY_MS = 86_400_000;

/** Devises portant une bande. Le dollar est le numéraire et finance les autres. */
export const CURRENCIES: readonly Currency[] = ['EUR', 'GBP', 'BRL'];

/** Coût du capital annuel de l'institution. */
export const ANNUAL_CARRY = 0.06;
export const CARRY_PER_EPOCH = ANNUAL_CARRY / 365 / EPOCHS_PER_DAY;

/** Coût d'une rupture de solde : pénalité de service plus financement d'urgence (D14). */
export const BREACH_COST = 50_000;

/** Aversion au risque : poids du terme de change dans la fonction objectif. */
export const KAPPA = 0.1;

/** Multiplicateur d'ES gaussienne à 97,5 % — φ(z)/(1−α). */
export const ES_FACTOR_975 = 2.337803;

/**
 * Coefficient d'impact de marché.
 *
 * Il n'est **pas calibré** — la profondeur réelle du carnet d'Arc est inconnue (SPEC
 * §4.6). Mais une valeur invraisemblable rendrait tout le backtest inexploitable, et le
 * premier jet l'était : `eta = 0,05` signifie 5 % de coût pour un ordre égal à la
 * profondeur affichée, donc 158 points de base à seulement 10 % de cette profondeur.
 * Le coût d'exécution écrasait alors le coût de portage d'un facteur 280 et le résultat
 * ne mesurait plus qu'un paramètre inventé.
 *
 * Avec l'impact en racine carrée, `eta` se lit directement comme le coût relatif d'un
 * ordre consommant toute la profondeur. Vingt à vingt-cinq points de base pour un
 * carnet de change liquide est un ordre de grandeur défendable. La sensibilité du
 * résultat à ce paramètre est publiée avec le résultat lui-même.
 */
export const ETA_EUR = 0.002;
export const ETA_GBP = 0.0025;

/**
 * Coûts par devise.
 *
 * EUR et GBP se règlent en stablecoin sur Arc : coût fixe de l'ordre du cent, finalité
 * sub-seconde. Le BRL n'a pas de stablecoin crédible et passe par un correspondant
 * bancaire : coût fixe trois ordres de grandeur au-dessus, règlement à J+2. C'est ce
 * contraste qui fait tout l'intérêt de la posture hybride (D2).
 */
export const CURRENCY_COSTS: Readonly<Record<string, CurrencyCosts>> = {
  EUR: {
    costs: {
      gammaFixed: 0.02,
      spreadBps: 2,
      etaImpact: ETA_EUR,
      depth: 5_000_000,
      carryRate: CARRY_PER_EPOCH,
      kappa: KAPPA,
      esPerUnit: 0,
      breachCost: BREACH_COST,
    },
    settlementDays: 1 / EPOCHS_PER_DAY,
  },
  GBP: {
    costs: {
      gammaFixed: 0.02,
      spreadBps: 3,
      etaImpact: ETA_GBP,
      depth: 2_000_000,
      carryRate: CARRY_PER_EPOCH,
      kappa: KAPPA,
      esPerUnit: 0,
      breachCost: BREACH_COST,
    },
    settlementDays: 1 / EPOCHS_PER_DAY,
  },
  BRL: {
    costs: {
      gammaFixed: 25,
      spreadBps: 35,
      etaImpact: 0,
      depth: 0,
      carryRate: CARRY_PER_EPOCH,
      kappa: KAPPA,
      esPerUnit: 0,
      breachCost: BREACH_COST,
    },
    settlementDays: 2,
  },
};

export interface BacktestConfig {
  readonly seeds: readonly number[];
  readonly startTs: number;
  /** Jours servant uniquement à amorcer la calibration, jamais évalués. */
  readonly warmupDays: number;
  /** Longueur d'une fenêtre d'évaluation, en jours. */
  readonly evalDays: number;
  readonly windows: number;
  /** Trajectoires bootstrap pour la résolution des bandes. */
  readonly solverPaths: number;
  readonly solverPathLength: number;
}

export const DEFAULT_CONFIG: BacktestConfig = {
  seeds: Array.from({ length: 20 }, (_, i) => 1000 + i),
  startTs: Date.UTC(2025, 0, 1),
  warmupDays: 90,
  evalDays: 30,
  windows: 6,
  solverPaths: 200,
  solverPathLength: 300,
};

/** Configuration réduite pour les tests : mêmes chemins de code, coût maîtrisé. */
export const FAST_CONFIG: BacktestConfig = {
  ...DEFAULT_CONFIG,
  seeds: [1000, 1001],
  warmupDays: 45,
  evalDays: 15,
  windows: 2,
  solverPaths: 60,
  solverPathLength: 120,
};
