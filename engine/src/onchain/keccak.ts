/**
 * Keccak-256, l'algorithme de hachage d'Ethereum.
 *
 * Node expose `sha3-256`, qui n'est **pas** la même fonction : la normalisation SHA-3 a
 * changé l'octet de bourrage de `0x01` à `0x06` après la publication de Keccak. Un octet
 * d'écart, des empreintes entièrement différentes — et Ethereum a conservé la version
 * d'origine. D'où cette implémentation, qui reste dans la discipline du dépôt : aucune
 * dépendance.
 *
 * Les états sont représentés en `bigint` sur 64 bits plutôt qu'en paires de mots de
 * 32 bits. C'est plus lent, et sans importance : on hache des structures de quelques
 * centaines d'octets, pas des blocs.
 */

const MASK64 = (1n << 64n) - 1n;
const RATE_BYTES = 136; // 1088 bits, le débit de Keccak-256

const ROUND_CONSTANTS: readonly bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

function rotl(x: bigint, n: number): bigint {
  const s = BigInt(n % 64);
  if (s === 0n) return x & MASK64;
  return ((x << s) | (x >> (64n - s))) & MASK64;
}

/** Permutation Keccak-f[1600], appliquée sur place. */
function keccakF(a: bigint[]): void {
  for (let round = 0; round < 24; round++) {
    // θ — diffusion par colonnes
    const c = new Array<bigint>(5);
    for (let x = 0; x < 5; x++) {
      c[x] = a[x]! ^ a[x + 5]! ^ a[x + 10]! ^ a[x + 15]! ^ a[x + 20]!;
    }
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5]! ^ rotl(c[(x + 1) % 5]!, 1);
      for (let y = 0; y < 25; y += 5) a[x + y] = a[x + y]! ^ d;
    }

    // ρ et π — rotations et permutation des positions
    let x = 1;
    let y = 0;
    let current = a[1]!;
    for (let t = 0; t < 24; t++) {
      const nextX = y;
      const nextY = (2 * x + 3 * y) % 5;
      const index = nextX + 5 * nextY;
      const kept = a[index]!;
      a[index] = rotl(current, ((t + 1) * (t + 2)) / 2);
      current = kept;
      x = nextX;
      y = nextY;
    }

    // χ — la seule étape non linéaire
    for (let row = 0; row < 25; row += 5) {
      const r0 = a[row]!;
      const r1 = a[row + 1]!;
      const r2 = a[row + 2]!;
      const r3 = a[row + 3]!;
      const r4 = a[row + 4]!;
      a[row] = r0 ^ (~r1 & MASK64 & r2);
      a[row + 1] = r1 ^ (~r2 & MASK64 & r3);
      a[row + 2] = r2 ^ (~r3 & MASK64 & r4);
      a[row + 3] = r3 ^ (~r4 & MASK64 & r0);
      a[row + 4] = r4 ^ (~r0 & MASK64 & r1);
    }

    // ι — brise la symétrie entre les tours
    a[0] = a[0]! ^ ROUND_CONSTANTS[round]!;
  }
}

export function keccak256(input: Uint8Array): Uint8Array {
  const state = new Array<bigint>(25).fill(0n);

  // Bourrage pad10*1 avec l'octet de domaine 0x01 — celui de Keccak, pas celui de SHA-3.
  const padded = new Uint8Array(Math.ceil((input.length + 1) / RATE_BYTES) * RATE_BYTES);
  padded.set(input);
  padded[input.length] = 0x01;
  padded[padded.length - 1] = (padded[padded.length - 1] ?? 0) | 0x80;

  for (let offset = 0; offset < padded.length; offset += RATE_BYTES) {
    for (let lane = 0; lane < RATE_BYTES / 8; lane++) {
      let value = 0n;
      // Les lanes sont en petit-boutiste.
      for (let byte = 7; byte >= 0; byte--) {
        value = (value << 8n) | BigInt(padded[offset + lane * 8 + byte]!);
      }
      state[lane] = state[lane]! ^ value;
    }
    keccakF(state);
  }

  const out = new Uint8Array(32);
  for (let lane = 0; lane < 4; lane++) {
    let value = state[lane]!;
    for (let byte = 0; byte < 8; byte++) {
      out[lane * 8 + byte] = Number(value & 0xffn);
      value >>= 8n;
    }
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new RangeError('chaîne hexadécimale de longueur impaire');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

export function keccak256Hex(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  return toHex(keccak256(bytes));
}
