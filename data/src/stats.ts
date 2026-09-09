/** Statistiques descriptives — support des tests de validité du générateur (SPEC §17.2). */

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function variance(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
}

export function stdev(xs: readonly number[]): number {
  return Math.sqrt(variance(xs));
}

/**
 * Kurtosis non centrée (une gaussienne vaut 3).
 *
 * Estimateur bruité sur des lois à queue lourde — c'est attendu : on ne teste que le
 * signe de l'excès, pas sa valeur. Une queue mince ici signifierait que la VaR calculée
 * plus loin sous-estimerait le risque de rupture.
 */
export function kurtosis(xs: readonly number[]): number {
  const m = mean(xs);
  const n = xs.length;
  if (n < 4) return 0;
  const m2 = xs.reduce((a, x) => a + (x - m) ** 2, 0) / n;
  const m4 = xs.reduce((a, x) => a + (x - m) ** 4, 0) / n;
  return m4 / m2 ** 2;
}

/** Autocorrélation empirique au retard `lag`. */
export function autocorrelation(xs: readonly number[], lag: number): number {
  const n = xs.length;
  if (lag <= 0 || lag >= n) return Number.NaN;
  const m = mean(xs);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const d = xs[i]! - m;
    den += d * d;
    if (i + lag < n) num += d * (xs[i + lag]! - m);
  }
  return den === 0 ? 0 : num / den;
}

/** Empreinte déterministe d'une série de nombres — support du test de reproductibilité. */
export function fingerprint(values: readonly number[]): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const buf = new DataView(new ArrayBuffer(8));
  for (const v of values) {
    buf.setFloat64(0, v);
    for (let b = 0; b < 8; b++) {
      const byte = buf.getUint8(b);
      h1 = Math.imul(h1 ^ byte, 0x01000193) >>> 0;
      h2 = Math.imul(h2 + byte, 0x85ebca6b) >>> 0;
    }
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}
