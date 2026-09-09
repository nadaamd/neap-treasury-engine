/**
 * Profils de saisonnalité de l'intensité d'arrivée des paiements.
 *
 * Invariant central : **chaque profil a une moyenne de 1 sur son cycle**. Le volume quotidien
 * calibré est donc préservé quelle que soit la forme des profils — on peut retoucher la forme
 * sans recalibrer l'intensité. Cet invariant est testé (data/test/seasonality.test.ts).
 */

function normalize(raw: readonly number[]): readonly number[] {
  const mean = raw.reduce((a, b) => a + b, 0) / raw.length;
  return raw.map((x) => x / mean);
}

/**
 * Profil horaire (UTC), bimodal : creux nocturne, montée matinale, pic de milieu de matinée,
 * second pic en début d'après-midi, décroissance en soirée.
 * Forme typique des paiements de détail et de PME en zone euro.
 */
const HOUR_RAW = [
  0.15, 0.10, 0.08, 0.07, 0.08, 0.12, 0.25, 0.55,
  1.10, 1.60, 1.85, 1.90, 1.55, 1.45, 1.70, 1.75,
  1.65, 1.50, 1.30, 1.05, 0.85, 0.65, 0.45, 0.28,
];
export const HOUR_PROFILE = normalize(HOUR_RAW);

/**
 * Profil hebdomadaire, indexé comme `Date.getUTCDay()` (0 = dimanche).
 * Calibré pour un creux de week-end de l'ordre de −60 % par rapport à la semaine
 * (SPEC §17.1), ce qui est le point de contrôle testé.
 */
const DOW_RAW = [0.45, 1.25, 1.30, 1.30, 1.30, 1.35, 0.60];
export const DOW_PROFILE = normalize(DOW_RAW);

/**
 * Profil par quantième du mois (index 0 = le 1er).
 * Deux effets de paie : pic marqué le 1er, plateau haut en fin de mois.
 * Les mois de moins de 31 jours n'utilisent pas les dernières entrées, ce qui introduit
 * un biais résiduel de quelques pour cent sur la moyenne annuelle — borné par le test.
 */
const DOM_RAW = [
  1.90, 1.45, 1.30, 0.95, 0.85, 0.82, 0.80, 0.80, 0.82, 0.85,
  0.88, 0.90, 0.92, 1.00, 1.15, 1.00, 0.90, 0.86, 0.84, 0.84,
  0.86, 0.90, 0.98, 1.10, 1.30, 1.35, 1.38, 1.40, 1.40, 1.38, 1.35,
];
export const DOM_PROFILE = normalize(DOM_RAW);

/** Multiplicateur d'intensité pour un instant donné. */
export function seasonalFactor(ts: number): number {
  const d = new Date(ts);
  return (
    HOUR_PROFILE[d.getUTCHours()]! *
    DOW_PROFILE[d.getUTCDay()]! *
    DOM_PROFILE[d.getUTCDate() - 1]!
  );
}
