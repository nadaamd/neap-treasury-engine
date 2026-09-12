/**
 * Les quatre politiques comparées — SPEC §18.2.
 *
 * Elles partagent la même mécanique de bandes et le même moteur d'exécution : seule
 * change la façon dont les bandes sont obtenues, et la cadence à laquelle on regarde
 * l'état. C'est délibéré — si les politiques différaient aussi par leur plomberie, la
 * comparaison mesurerait autre chose que ce qu'on veut mesurer.
 */

import type { Currency } from '../../../data/src/types.ts';
import { millerOrrBands } from '../bands/millerOrr.ts';
import type { Bands } from '../bands/millerOrr.ts';
import { bootstrapPaths } from '../bands/simulate.ts';
import type { CostParams } from '../bands/simulate.ts';
import { solveBands } from '../bands/solver.ts';
import { empiricalLeftTail } from '../bands/tail.ts';
import { mean, stdev } from '../../../data/src/stats.ts';
import { CURRENCIES, CURRENCY_COSTS, EPOCHS_PER_DAY, ES_FACTOR_975 } from './config.ts';
import type { BacktestConfig } from './config.ts';
import type { PolicyBands, PolicyKind } from './types.ts';

/**
 * Pire besoin de trésorerie intrajournalier observé.
 *
 * C'est ainsi qu'une trésorerie dimensionne un pré-financement en pratique : on regarde
 * la pire journée du passé récent et on provisionne autant. La méthode est robuste et
 * chère — elle ignore le coût du capital, la structure des flux et le risque de change.
 *
 * Le premier jet mesurait la pire *sortie nette journalière*. C'était faux, et le
 * backtest l'a montré sans ambiguïté : sur un corridor structurellement entrant comme
 * l'euro, la sortie nette la plus défavorable est proche de zéro, la bande devenait
 * dérisoire et la politique censée être la plus conservatrice accumulait quatre cent
 * quarante ruptures. Un solde net positif sur la journée ne dit rien du creux traversé
 * en cours de route.
 *
 * La bonne grandeur est le **maximum de repli du flux cumulé à l'intérieur d'une
 * journée** : combien de liquidité il faut détenir au matin pour absorber la pire série
 * de sorties avant que les entrées ne compensent. On la mesure jour par jour et on
 * retient le pire, ce qui borne le buffer à un horizon de réapprovisionnement d'un jour
 * — au-delà, une trésorerie recharge plutôt que de provisionner.
 */
function worstIntradayDrawdown(epochFlows: readonly number[]): number {
  let worst = 0;
  const days = Math.floor(epochFlows.length / EPOCHS_PER_DAY);
  for (let d = 0; d < days; d++) {
    let cumulative = 0;
    let peak = 0;
    for (let i = 0; i < EPOCHS_PER_DAY; i++) {
      cumulative += epochFlows[d * EPOCHS_PER_DAY + i]!;
      if (cumulative > peak) peak = cumulative;
      const drawdown = peak - cumulative;
      if (drawdown > worst) worst = drawdown;
    }
  }
  return Math.max(worst, 1);
}

/** ES par unité d'exposition sur l'horizon d'une période, à partir de la volatilité du jour. */
export function esPerUnit(dailyVol: number): number {
  return ES_FACTOR_975 * dailyVol * Math.sqrt(1 / EPOCHS_PER_DAY);
}

function solveFor(
  flows: readonly number[],
  currency: Currency,
  dailyVol: number,
  cfg: BacktestConfig,
  seed: number,
  override?: CostParams,
): Bands {
  const drift = mean(flows);
  const centred = flows.map((x) => x - drift);
  const sigma = Math.max(stdev(centred), 1);
  const base = override ?? CURRENCY_COSTS[currency]!.costs;
  const costs = { ...base, esPerUnit: esPerUnit(dailyVol) };

  // Les bandes sont amorcées par Miller-Orr sur la série sans dérive — c'est son cadre
  // d'hypothèses — puis raffinées numériquement sur les flux réels, dérive comprise.
  const warmStart = millerOrrBands({
    gammaFixed: costs.gammaFixed,
    flowSigma: sigma,
    carryRate: costs.carryRate,
    lower: 0,
  });
  const spread = Math.max(warmStart.target - warmStart.lower, 1);

  return solveBands({
    paths: bootstrapPaths(flows, cfg.solverPaths, cfg.solverPathLength, seed),
    costs,
    tail: empiricalLeftTail(flows),
    warmStart,
    floor: 0,
    initialStep: spread / 2,
    tolerance: spread / 256,
    maxEvaluations: 3000,
  }).bands;
}

export interface PolicyInput {
  /** Flux de la fenêtre de calibration — le passé strict. */
  readonly calibration: Record<Currency, number[]>;
  /**
   * Flux de la fenêtre d'évaluation. Réservé à CLAIRVOYANT, qui est une **borne
   * supérieure** et non une politique implémentable.
   */
  readonly evaluation: Record<Currency, number[]>;
  /** Volatilité quotidienne par devise, estimée sur la calibration. */
  readonly dailyVol: Record<Currency, number>;
  readonly cfg: BacktestConfig;
  readonly seed: number;
  /**
   * Coûts par devise se substituant à ceux du dépôt.
   *
   * Sans ce passage explicite, le solveur lisait toujours les constantes du module et
   * les curseurs du tableau de bord n'avaient aucun effet sur les bandes : la page
   * affichait des paramètres qu'elle prétendait faire varier. Le contrôle de contrat
   * entre l'API et la page l'a détecté ; une capture d'écran ne l'aurait pas montré.
   */
  readonly costs?: Readonly<Record<string, CostParams>>;
}

export function buildPolicy(kind: PolicyKind, input: PolicyInput): PolicyBands {
  const bands = {} as Record<Currency, Bands>;

  for (const c of CURRENCIES) {
    const calib = input.calibration[c]!;
    switch (kind) {
      case 'STATIC': {
        // Pré-financement conservateur, jamais optimisé : on provisionne la pire journée
        // observée, on réapprovisionne quand le solde tombe sous le quart, on ne dégage
        // l'excédent qu'au-delà du triple.
        const z = worstIntradayDrawdown(calib);
        bands[c] = { lower: 0.25 * z, target: z, upper: 3 * z };
        break;
      }
      case 'CALENDAR': {
        // Même dimensionnement, mais décision à heure fixe : la pratique de trésorerie
        // la plus répandue, et le témoin réaliste de la comparaison.
        const z = worstIntradayDrawdown(calib);
        bands[c] = { lower: 0, target: z, upper: Number.POSITIVE_INFINITY };
        break;
      }
      case 'NEAP':
        bands[c] = solveFor(calib, c, input.dailyVol[c]!, input.cfg, input.seed, input.costs?.[c]);
        break;
      case 'CLAIRVOYANT':
        bands[c] = solveFor(
          input.evaluation[c]!,
          c,
          input.dailyVol[c]!,
          input.cfg,
          input.seed,
          input.costs?.[c],
        );
        break;
    }
  }

  return { bands, calendarOnly: kind === 'CALENDAR' };
}
