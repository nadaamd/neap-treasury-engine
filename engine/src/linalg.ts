/**
 * Minimal linear algebra for small-dimension covariance matrices (n ≤ 8).
 *
 * No dependencies: the engine must stay a pure function portable into the CRE handler
 * (decision D9), hence no native library and no WASM.
 */

export type Matrix = number[][];
/** Functions never write into a vector: the type says so. */
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

/** Normalised Frobenius inner product: ⟨A,B⟩ = tr(A Bᵀ) / n. Ledoit-Wolf convention. */
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

/** Quadratic form wᵀ A w. */
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
 * Cholesky decomposition. Returns null when the matrix is not positive definite — this
 * is the cheapest positivity test, and it doubles as a sanity check on any estimated
 * covariance matrix.
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
 * Eigenvalues of a symmetric matrix by cyclic Jacobi rotations.
 *
 * Chosen for its robustness in small dimension and because it fits in forty lines with
 * no dependency. Returns the eigenvalues sorted in decreasing order.
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
 * Spectral condition number λ_max / λ_min.
 *
 * This is the measure that justifies shrinkage: a covariance estimated on few
 * observations is ill-conditioned, and its inverse — used by any portfolio
 * optimisation — then amplifies estimation noise instead of damping it.
 */
export function conditionNumber(a: Matrix): number {
  const ev = symmetricEigenvalues(a);
  const max = ev[0]!;
  const min = ev[ev.length - 1]!;
  if (min <= 0) return Number.POSITIVE_INFINITY;
  return max / min;
}
