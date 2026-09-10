/**
 * Algèbre linéaire minimale pour des matrices de covariance de petite dimension (n ≤ 8).
 *
 * Aucune dépendance : le moteur doit rester une fonction pure portable dans le handler
 * CRE (décision D9), donc sans bibliothèque native ni WASM.
 */

export type Matrix = number[][];
/** Les fonctions n'écrivent jamais dans un vecteur : le type l'énonce. */
export type Vector = readonly number[];

export function zeros(n: number, m: number = n): Matrix {
  return Array.from({ length: n }, () => new Array<number>(m).fill(0));
}

export function identity(n: number): Matrix {
  const out = zeros(n);
  for (let i = 0; i < n; i++) out[i]![i] = 1;
  return out;
}

export function trace(a: Matrix): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]![i]!;
  return s;
}

/** Produit scalaire de Frobenius normalisé : ⟨A,B⟩ = tr(A Bᵀ) / n. Convention de Ledoit-Wolf. */
export function frobeniusInner(a: Matrix, b: Matrix): number {
  const n = a.length;
  let s = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) s += a[i]![j]! * b[i]![j]!;
  }
  return s / n;
}

export function frobeniusNormSq(a: Matrix): number {
  return frobeniusInner(a, a);
}

/** Forme quadratique wᵀ A w. */
export function quadForm(w: Vector, a: Matrix): number {
  let s = 0;
  for (let i = 0; i < w.length; i++) {
    const wi = w[i]!;
    if (wi === 0) continue;
    for (let j = 0; j < w.length; j++) s += wi * a[i]![j]! * w[j]!;
  }
  return s;
}

/**
 * Décomposition de Cholesky. Renvoie null si la matrice n'est pas définie positive —
 * c'est le test de positivité le moins cher, et il sert de contrôle de sanité sur toute
 * matrice de covariance estimée.
 */
export function cholesky(a: Matrix): Matrix | null {
  const n = a.length;
  const l = zeros(n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = a[i]![j]!;
      for (let k = 0; k < j; k++) sum -= l[i]![k]! * l[j]![k]!;
      if (i === j) {
        if (sum <= 0) return null;
        l[i]![j] = Math.sqrt(sum);
      } else {
        l[i]![j] = sum / l[j]![j]!;
      }
    }
  }
  return l;
}

/**
 * Valeurs propres d'une matrice symétrique par rotations de Jacobi cycliques.
 *
 * Choisi pour sa robustesse en petite dimension et parce qu'il tient en quarante lignes
 * sans dépendance. Renvoie les valeurs propres triées par ordre décroissant.
 */
export function symmetricEigenvalues(a: Matrix, maxSweeps = 100, tol = 1e-14): number[] {
  const n = a.length;
  const m: Matrix = a.map((row) => row.slice());

  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) off += m[i]![j]! * m[i]![j]!;
    }
    if (off < tol) break;

    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = m[p]![q]!;
        if (Math.abs(apq) < 1e-300) continue;
        const theta = (m[q]![q]! - m[p]![p]!) / (2 * apq);
        const t =
          Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const mkp = m[k]![p]!;
          const mkq = m[k]![q]!;
          m[k]![p] = c * mkp - s * mkq;
          m[k]![q] = s * mkp + c * mkq;
        }
        for (let k = 0; k < n; k++) {
          const mpk = m[p]![k]!;
          const mqk = m[q]![k]!;
          m[p]![k] = c * mpk - s * mqk;
          m[q]![k] = s * mpk + c * mqk;
        }
      }
    }
  }

  return Array.from({ length: n }, (_, i) => m[i]![i]!).sort((x, y) => y - x);
}

/**
 * Conditionnement spectral λ_max / λ_min.
 *
 * C'est la mesure qui justifie le shrinkage : une covariance estimée sur peu
 * d'observations est mal conditionnée, et son inverse — utilisée par toute optimisation
 * de portefeuille — amplifie alors le bruit d'estimation.
 */
export function conditionNumber(a: Matrix): number {
  const ev = symmetricEigenvalues(a);
  const max = ev[0]!;
  const min = ev[ev.length - 1]!;
  if (min <= 0) return Number.POSITIVE_INFINITY;
  return max / min;
}
