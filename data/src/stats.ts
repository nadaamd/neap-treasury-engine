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

/**
 * Statistique de Ljung-Box sur `m` retards.
 *
 *   Q = T(T+2) Σ_{k=1..m} ρ_k² / (T−k)
 *
 * Appliquée aux rendements *au carré*, c'est le test standard de détection d'effets
 * ARCH : elle agrège la corrélation sérielle sur plusieurs retards au lieu de parier
 * sur un retard isolé. Sous l'hypothèse nulle d'absence d'autocorrélation, Q suit
 * approximativement une loi du khi-deux à m degrés de liberté.
 */
export function ljungBox(xs: readonly number[], m: number): number {
  const T = xs.length;
  let q = 0;
  for (let k = 1; k <= m; k++) {
    const rho = autocorrelation(xs, k);
    q += (rho * rho) / (T - k);
  }
  return T * (T + 2) * q;
}

/** Valeurs critiques du khi-deux au seuil de 1 %, indexées par les degrés de liberté. */
export const CHI2_99: Readonly<Record<number, number>> = {
  5: 15.086,
  10: 23.209,
  20: 37.566,
};

/** Mélange déterministe de Fisher-Yates — sert de contrôle négatif dans les tests. */
export function shuffled<T>(xs: readonly T[], nextU32: () => number): T[] {
  const out = xs.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = nextU32() % (i + 1);
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}
