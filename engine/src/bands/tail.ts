/**
 * Modèle de queue gauche de la distribution des flux nets.
 *
 * ─── Pourquoi ce module existe ────────────────────────────────────────────────
 * La première version de la fonction objectif facturait le coût de rupture en
 * **comptant** les passages du solde sous zéro dans la simulation. Le solveur s'est
 * révélé insensible à ce coût : entre 20 k$ et 5 M$ par rupture, l'optimum ne bougeait
 * pas d'un dollar.
 *
 * La cause n'est pas un bug mais une limite de résolution. Au voisinage de l'optimum,
 * la probabilité de rupture par période est de l'ordre de 10⁻⁵ — on la déduit de
 * l'égalisation des coûts marginaux : abaisser le buffer de 100 k$ économise 0,17 $ de
 * portage par période, ce qui n'est rentable que si la probabilité de rupture ajoutée
 * reste sous 10⁻⁵ pour un coût de 20 k$. Or 300 trajectoires × 400 périodes ne font que
 * 120 000 tirages : un événement à 10⁻⁵ n'y apparaît quasiment jamais. Le terme mesuré
 * valait zéro partout, donc son gradient aussi.
 *
 * **Un coût d'événement rare doit être tarifé analytiquement, pas compté.** On remplace
 * donc l'indicateur par une espérance : à chaque période on facture
 * `coût_rupture × P(flux < −solde)`, ce qui est une fonction lisse et strictement
 * positive du solde — donc exploitable par l'optimiseur.
 *
 * ─── Modèle retenu ────────────────────────────────────────────────────────────
 * Fonction de répartition empirique dans le domaine observé, prolongée par une queue
 * exponentielle au-delà du minimum observé. C'est l'approximation du premier ordre de la
 * théorie des valeurs extrêmes par dépassements de seuil : au-delà d'un seuil assez
 * bas, les excès suivent approximativement une loi de Pareto généralisée, dont le cas
 * ξ = 0 est l'exponentielle. On assume ce ξ = 0 plutôt que de l'estimer sur un
 * échantillon qui ne le supporterait pas.
 */

export interface TailModel {
  /** P(X < x). */
  probBelow(x: number): number;
  /** Seuil au-delà duquel l'extrapolation exponentielle prend le relais. */
  readonly threshold: number;
  /** Paramètre d'échelle de la queue exponentielle. */
  readonly scale: number;
}

export function empiricalLeftTail(
  history: readonly number[],
  tailFraction = 0.05,
): TailModel {
  if (history.length < 20) throw new RangeError('historique trop court pour estimer une queue');
  const sorted = history.slice().sort((a, b) => a - b);
  const n = sorted.length;

  const k = Math.max(2, Math.floor(n * tailFraction));
  const threshold = sorted[k - 1]!;
  const f0 = k / n;

  // Excès moyen sous le seuil : estimateur du maximum de vraisemblance de l'échelle
  // exponentielle.
  let excess = 0;
  for (let i = 0; i < k; i++) excess += threshold - sorted[i]!;
  const scale = Math.max(excess / k, Number.EPSILON);

  const probBelow = (x: number): number => {
    if (x <= threshold) {
      return f0 * Math.exp(-(threshold - x) / scale);
    }
    if (x >= sorted[n - 1]!) return 1;
    // Interpolation linéaire sur la fonction de répartition empirique.
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]! < x) lo = mid + 1;
      else hi = mid;
    }
    return lo / n;
  };

  return { probBelow, threshold, scale };
}
