/**
 * Générateur pseudo-aléatoire déterministe et lois de tirage.
 *
 * Contrainte de conception : le backtest doit être reproductible (SPEC §17.2, test 5).
 * `Math.random()` est donc proscrit dans tout le dépôt — il n'est pas amorçable et
 * son implémentation varie selon le moteur JS.
 *
 * Algorithme : xoshiro128** (Blackman & Vigna), amorcé par splitmix32.
 * Période 2^128-1, qualité statistique suffisante pour de la simulation Monte-Carlo,
 * et surtout : entièrement spécifié, donc identique sur toute plateforme.
 */

const TWO_POW_32 = 4294967296;

function splitmix32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad) >>> 0;
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97) >>> 0;
    return (t ^ (t >>> 15)) >>> 0;
  };
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** Approximation de Lanczos de log Γ(x), requise par le tirage de Poisson (PTRS). */
const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7,
];

export function logGamma(x: number): number {
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const z = x - 1;
  let a = 0.99999999999980993;
  for (let i = 0; i < LANCZOS.length; i++) a += LANCZOS[i]! / (z + i + 1);
  const t = z + LANCZOS.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;
  private spareNormal: number | null = null;

  constructor(seed: number) {
    const sm = splitmix32(seed);
    this.s0 = sm();
    this.s1 = sm();
    this.s2 = sm();
    this.s3 = sm();
  }

  /** Entier non signé sur 32 bits. */
  nextU32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  /** Uniforme sur [0, 1). */
  uniform(): number {
    return this.nextU32() / TWO_POW_32;
  }

  /** Uniforme sur ]0, 1), bornée strictement pour les logarithmes. */
  private uniformOpen(): number {
    const u = this.uniform();
    return u === 0 ? Number.EPSILON : u;
  }

  /** Normale centrée réduite, par Box-Muller polaire (la seconde valeur est mise en cache). */
  normal(): number {
    if (this.spareNormal !== null) {
      const v = this.spareNormal;
      this.spareNormal = null;
      return v;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = this.uniform() * 2 - 1;
      v = this.uniform() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const mul = Math.sqrt((-2 * Math.log(s)) / s);
    this.spareNormal = v * mul;
    return u * mul;
  }

  /**
   * Log-normale de moyenne arithmétique `mean` et de paramètre de forme `sigma`.
   *
   * On paramètre par la moyenne observable plutôt que par mu, parce que les sources de
   * calibration publient des tailles moyennes de paiement, pas des mu de log-normale.
   * Relation : mu = ln(mean) - sigma²/2.
   */
  lognormalWithMean(mean: number, sigma: number): number {
    const mu = Math.log(mean) - (sigma * sigma) / 2;
    return Math.exp(mu + sigma * this.normal());
  }

  /**
   * Poisson(lambda).
   *
   * lambda < 30  : algorithme de Knuth (produit d'uniformes), exact.
   * lambda >= 30 : rejet transformé avec squeeze (Hörmann 1993, « PTRS »), exact également.
   *
   * On évite volontairement l'approximation normale usuelle : elle biaise la queue basse,
   * or ce sont précisément les heures creuses qui déterminent les ruptures de seuil.
   */
  poisson(lambda: number): number {
    if (lambda <= 0) return 0;
    if (lambda < 30) {
      const limit = Math.exp(-lambda);
      let k = 0;
      let p = 1;
      do {
        k++;
        p *= this.uniform();
      } while (p > limit);
      return k - 1;
    }
    const b = 0.931 + 2.53 * Math.sqrt(lambda);
    const a = -0.059 + 0.02483 * b;
    const invAlpha = 1.1239 + 1.1328 / (b - 3.4);
    const vr = 0.9277 - 3.6224 / (b - 2);
    const logLambda = Math.log(lambda);
    for (;;) {
      const u = this.uniform() - 0.5;
      const v = this.uniformOpen();
      const us = 0.5 - Math.abs(u);
      const k = Math.floor(((2 * a) / us + b) * u + lambda + 0.43);
      if (us >= 0.07 && v <= vr) return k;
      if (k < 0 || (us < 0.013 && v > us)) continue;
      const lhs = Math.log((v * invAlpha) / (a / (us * us) + b));
      const rhs = -lambda + k * logLambda - logGamma(k + 1);
      if (lhs <= rhs) return k;
    }
  }

  /** Choix binaire de probabilité p. */
  bernoulli(p: number): boolean {
    return this.uniform() < p;
  }
}
