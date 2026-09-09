/**
 * Exécute le backtest walk-forward et publie le tableau de résultats.
 *
 *   node engine/scripts/backtest.ts [--fast] [--json <fichier>] [--no-sensitivity]
 *
 * Le tableau est conçu pour être lu par quelqu'un qui cherchera la faille : chaque
 * chiffre porte son intervalle de confiance, les hypothèses non calibrées sont nommées,
 * et la sensibilité au seul paramètre inventé du modèle est publiée à côté du résultat.
 */

import { writeFileSync } from 'node:fs';
import { DEFAULT_CONFIG, FAST_CONFIG, CURRENCY_COSTS, ANNUAL_CARRY } from '../src/backtest/config.ts';
import type { BacktestConfig } from '../src/backtest/config.ts';
import { runBacktest } from '../src/backtest/walkforward.ts';
import type { BacktestSummary, Interval, PolicyKind } from '../src/backtest/types.ts';

const POLICIES: readonly PolicyKind[] = ['STATIC', 'CALENDAR', 'FLOAT', 'CLAIRVOYANT'];

const LABEL: Record<PolicyKind, string> = {
  STATIC: 'STATIC      (pré-financement conservateur)',
  CALENDAR: 'CALENDAR    (rééquilibrage de fin de journée)',
  FLOAT: 'FLOAT       (bandes optimisées, par signal)',
  CLAIRVOYANT: 'CLAIRVOYANT (calibré sur la période réalisée)',
};

function money(x: number): string {
  if (Math.abs(x) >= 1e6) return `${(x / 1e6).toFixed(2)} M$`;
  if (Math.abs(x) >= 1e3) return `${(x / 1e3).toFixed(1)} k$`;
  return `${x.toFixed(1)} $`;
}

function ci(i: Interval, fmt: (x: number) => string): string {
  return `${fmt(i.mean)} ± ${fmt(i.halfWidth)}`;
}

function pct(a: number, b: number): string {
  if (b === 0) return '—';
  const change = (a - b) / b;
  const sign = change > 0 ? '+' : '';
  return `${sign}${(change * 100).toFixed(1)} %`;
}

function render(summary: BacktestSummary): void {
  const m = summary.metrics;
  const ref = m.STATIC;

  console.log('');
  console.log('═'.repeat(96));
  console.log(`  FLOAT — backtest walk-forward · ${summary.seeds} germes × ${summary.windows} fenêtres`);
  console.log('═'.repeat(96));
  console.log('');
  console.log('  Moyennes par fenêtre d\'évaluation, avec intervalle de confiance à 95 %.');
  console.log('');

  const rows: string[][] = [
    ['Politique', 'Capital immobilisé', 'ES 97,5 %', 'Coût total', 'Exécution', 'Ruptures', 'Rééquil.'],
  ];
  for (const k of POLICIES) {
    rows.push([
      LABEL[k],
      ci(m[k].capital, money),
      ci(m[k].es, money),
      ci(m[k].totalCost, money),
      money(m[k].executionCost.mean),
      m[k].breaches.mean.toFixed(2),
      Math.round(m[k].rebalances.mean).toString(),
    ]);
  }
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  rows.forEach((r, idx) => {
    console.log('  ' + r.map((cell, i) => cell.padEnd(widths[i]!)).join('  │  '));
    if (idx === 0) console.log('  ' + widths.map((w) => '─'.repeat(w)).join('──┼──'));
  });

  console.log('');
  console.log('  Écarts de FLOAT par rapport au pré-financement conservateur :');
  console.log('');
  console.log(`    capital immobilisé   ${pct(m.FLOAT.capital.mean, ref.capital.mean)}`);
  console.log(`    ES 97,5 %            ${pct(m.FLOAT.es.mean, ref.es.mean)}`);
  console.log(`    coût total           ${pct(m.FLOAT.totalCost.mean, ref.totalCost.mean)}`);
  console.log(`    coût d'exécution     ${pct(m.FLOAT.executionCost.mean, ref.executionCost.mean)}`);
  console.log(`    nombre d'ordres      ${pct(m.FLOAT.rebalances.mean, ref.rebalances.mean)}`);

  const e = summary.estimationCost;
  console.log('');
  console.log("  Coût de l'incertitude d'estimation");
  console.log('  ' + '─'.repeat(92));
  console.log(`    FLOAT contre calibration sur la période réalisée : ${(e.mean * 100).toFixed(2)} % ± ${(e.halfWidth * 100).toFixed(2)} %`);
  if (Math.abs(e.mean) < e.halfWidth) {
    console.log("    L'intervalle contient zéro : calibrer sur le passé ne coûte rien de mesurable ici.");
  } else if (e.mean < 0) {
    console.log('    Négatif : calibrer sur la période réalisée fait *moins* bien que calibrer sur le');
    console.log("    passé. Ce n'est pas un paradoxe — le solveur est heuristique et le critère mesuré");
    console.log("    est le coût réalisé, pas celui qu'il minimise. CLAIRVOYANT n'est donc pas une borne");
    console.log("    supérieure, et l'écart, de l'ordre du pour cent, dit surtout que l'erreur");
    console.log('    d\'estimation n\'est pas le facteur limitant sur ces données.');
  } else {
    console.log("    Positif : l'erreur d'estimation a un coût mesurable.");
  }
  console.log('');

  console.log('  Lecture');
  console.log('  ' + '─'.repeat(92));
  console.log('    Le capital immobilisé et le risque de change s\'effondrent, le coût total baisse');
  console.log('    plus modestement. Ce n\'est pas une contradiction : à 6 % par an, le portage d\'un');
  console.log('    million de dollars sur une fenêtre de quelques semaines pèse peu face aux coûts');
  console.log('    d\'exécution. La valeur du capital libéré ne se lit pas dans le coût de portage,');
  console.log('    elle se lit dans le capital lui-même.');
  console.log('');
  console.log('    Le coût d\'exécution baisse *malgré* un nombre d\'ordres bien supérieur, et c\'est le');
  console.log('    mécanisme central : sous impact en racine carrée, beaucoup de petits ordres coûtent');
  console.log('    moins cher que quelques gros. Ce régime n\'est accessible que parce que le coût fixe');
  console.log('    d\'un rééquilibrage s\'est effondré sur le rail stablecoin — sur un rail de');
  console.log('    correspondant bancaire, mille trois cents ordres coûteraient à eux seuls plus que');
  console.log('    tout le reste.');
  console.log('');
  const breachFloat = m.FLOAT.breaches.mean;
  if (breachFloat > m.STATIC.breaches.mean) {
    console.log('    FLOAT tolère davantage de ruptures que le pré-financement conservateur, et c\'est');
    console.log('    l\'optimiseur qui fait son travail : le coût de rupture retenu est de 50 000 $, et à');
    console.log('    l\'optimum la probabilité de rupture varie en 1/c_b. Une institution qui valorise');
    console.log('    davantage une rupture de paiement obtient mécaniquement un buffer plus épais.');
    console.log('');
  }
}

function renderAssumptions(cfg: BacktestConfig): void {
  console.log('  Hypothèses — à lire avant les chiffres');
  console.log('  ' + '─'.repeat(92));
  console.log(`    Flux de paiement       synthétiques, Poisson composé calibré sur agrégats publics`);
  console.log(`    Marché de change       GARCH(1,1) à innovations de Student, germe indépendant des flux`);
  console.log(`    Coût du capital        ${(ANNUAL_CARRY * 100).toFixed(1)} % par an`);
  console.log(`    Impact de marché       NON CALIBRÉ — eta = ${CURRENCY_COSTS.EUR!.costs.etaImpact} sur l'euro`);
  console.log(`                           (coût relatif d'un ordre consommant toute la profondeur)`);
  console.log(`    Rail lent              BRL, coût fixe ${CURRENCY_COSTS.BRL!.costs.gammaFixed} $, règlement J+2`);
  console.log(`    Calibration            fenêtre extensible, ${cfg.warmupDays} jours d'amorçage`);
  console.log(`    Évaluation             ${cfg.evalDays} jours par fenêtre, jamais vus à la calibration`);
  console.log('');
}

function renderSensitivity(cfg: BacktestConfig): void {
  console.log('  Sensibilité au coefficient d\'impact — le seul paramètre inventé du modèle');
  console.log('  ' + '─'.repeat(92));

  const baseEur = CURRENCY_COSTS.EUR!.costs.etaImpact;
  const baseGbp = CURRENCY_COSTS.GBP!.costs.etaImpact;
  const mutable = CURRENCY_COSTS as Record<string, { costs: { etaImpact: number } }>;

  for (const factor of [0.5, 1, 2]) {
    mutable.EUR!.costs.etaImpact = baseEur * factor;
    mutable.GBP!.costs.etaImpact = baseGbp * factor;
    const s = runBacktest(cfg);
    const capital = pct(s.metrics.FLOAT.capital.mean, s.metrics.STATIC.capital.mean);
    const cost = pct(s.metrics.FLOAT.totalCost.mean, s.metrics.STATIC.totalCost.mean);
    console.log(
      `    eta × ${factor.toFixed(1).padStart(3)}   capital ${capital.padStart(8)}   coût total ${cost.padStart(8)}`,
    );
  }
  mutable.EUR!.costs.etaImpact = baseEur;
  mutable.GBP!.costs.etaImpact = baseGbp;
  console.log('');
}

function main(): void {
  const args = process.argv.slice(2);
  const cfg = args.includes('--fast') ? FAST_CONFIG : DEFAULT_CONFIG;

  const started = Date.now();
  const summary = runBacktest(cfg);
  render(summary);
  renderAssumptions(cfg);
  if (!args.includes('--no-sensitivity')) renderSensitivity(cfg);
  console.log(`  Durée : ${((Date.now() - started) / 1000).toFixed(1)} s`);
  console.log('');

  const jsonAt = args.indexOf('--json');
  if (jsonAt >= 0 && args[jsonAt + 1]) {
    writeFileSync(args[jsonAt + 1]!, JSON.stringify(summary, null, 2));
    console.log(`  Résultats écrits dans ${args[jsonAt + 1]}`);
  }
}

main();
