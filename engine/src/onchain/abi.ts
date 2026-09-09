/**
 * Encodage ABI minimal — strictement ce dont le moteur a besoin pour produire les mêmes
 * octets que `abi.encode` en Solidity.
 *
 * Ce n'est pas un encodeur général et ne prétend pas l'être. Il couvre deux formes, et
 * une suite de conformité vérifie que chacune produit exactement ce que Solidity produit.
 * Un encodeur incomplet mais vérifié vaut mieux qu'un encodeur complet supposé correct.
 */

import { fromHex, keccak256, toHex } from './keccak.ts';

const WORD = 32;
const TWO_POW_256 = 1n << 256n;

function word(value: bigint): Uint8Array {
  // Complément à deux pour les entiers signés : Solidity étend le signe sur 256 bits.
  const v = value < 0n ? TWO_POW_256 + value : value;
  if (v >= TWO_POW_256) throw new RangeError(`valeur hors capacité d'un mot : ${value}`);
  const out = new Uint8Array(WORD);
  let rest = v;
  for (let i = WORD - 1; i >= 0; i--) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

function addressWord(address: string): Uint8Array {
  const bytes = fromHex(address);
  if (bytes.length !== 20) throw new RangeError(`adresse invalide : ${address}`);
  const out = new Uint8Array(WORD);
  out.set(bytes, WORD - 20);
  return out;
}

function bytes32Word(hex: string): Uint8Array {
  const bytes = fromHex(hex);
  if (bytes.length !== 32) throw new RangeError(`bytes32 invalide : ${hex}`);
  return bytes;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Ordre tel que le coffre l'attend. Structure statique : quatre mots. */
export interface OnchainOrder {
  readonly sell: string;
  readonly buy: string;
  readonly amountIn: bigint;
  readonly minAmountOut: bigint;
}

/**
 * `abi.encode(Order[] orders, bytes32 salt)`.
 *
 * Le tuple de tête fait deux mots : un décalage vers le tableau, puis le sel. Le tableau
 * étant dynamique, son décalage vaut 0x40 — deux mots de tête — et sa charge utile
 * commence par la longueur, suivie de quatre mots par ordre. Les structures d'ordres sont
 * statiques, donc aucune indirection supplémentaire.
 */
export function encodeOrdersAndSalt(orders: readonly OnchainOrder[], salt: string): Uint8Array {
  const head = [word(0x40n), bytes32Word(salt)];
  const body: Uint8Array[] = [word(BigInt(orders.length))];
  for (const o of orders) {
    body.push(addressWord(o.sell), addressWord(o.buy), word(o.amountIn), word(o.minAmountOut));
  }
  return concat([...head, ...body]);
}

/** Engagement publié dans le rapport, révélé par le coffre au moment d'exécuter (D6). */
export function ordersCommitment(orders: readonly OnchainOrder[], salt: string): string {
  return toHex(keccak256(encodeOrdersAndSalt(orders, salt)));
}

export interface OnchainReport {
  readonly epoch: bigint;
  readonly nonce: bigint;
  readonly expiry: bigint;
  readonly inputsTimestamp: bigint;
  readonly policyVersion: bigint;
  readonly bandParamsHash: string;
  readonly inputsHash: string;
  readonly ordersCommitment: string;
  readonly esBeforeBps: bigint;
  readonly esAfterBps: bigint;
  readonly costEstimate: bigint;
  readonly grossNotional: bigint;
}

/** Doit reproduire mot pour mot la constante `REPORT_TYPEHASH` du vérificateur. */
export const REPORT_TYPE_STRING =
  'RebalanceReport(uint64 epoch,uint64 nonce,uint64 expiry,uint64 inputsTimestamp,' +
  'uint32 policyVersion,bytes32 bandParamsHash,bytes32 inputsHash,' +
  'bytes32 ordersCommitment,int32 esBeforeBps,int32 esAfterBps,uint128 costEstimate,' +
  'uint128 grossNotional)';

export const EIP712_DOMAIN_TYPE_STRING =
  'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)';

const encoder = new TextEncoder();

export function typeHash(signature: string): string {
  return toHex(keccak256(encoder.encode(signature)));
}

export function reportStructHash(report: OnchainReport): string {
  return toHex(
    keccak256(
      concat([
        bytes32Word(typeHash(REPORT_TYPE_STRING)),
        word(report.epoch),
        word(report.nonce),
        word(report.expiry),
        word(report.inputsTimestamp),
        word(report.policyVersion),
        bytes32Word(report.bandParamsHash),
        bytes32Word(report.inputsHash),
        bytes32Word(report.ordersCommitment),
        word(report.esBeforeBps),
        word(report.esAfterBps),
        word(report.costEstimate),
        word(report.grossNotional),
      ]),
    ),
  );
}

export function domainSeparator(chainId: bigint, verifyingContract: string): string {
  return toHex(
    keccak256(
      concat([
        bytes32Word(typeHash(EIP712_DOMAIN_TYPE_STRING)),
        bytes32Word(typeHash('FLOAT')),
        bytes32Word(typeHash('1')),
        word(chainId),
        addressWord(verifyingContract),
      ]),
    ),
  );
}

/** Empreinte signée par le quorum : 0x1901 ‖ séparateur de domaine ‖ empreinte de structure. */
export function reportDigest(
  report: OnchainReport,
  chainId: bigint,
  verifyingContract: string,
): string {
  return toHex(
    keccak256(
      concat([
        new Uint8Array([0x19, 0x01]),
        bytes32Word(domainSeparator(chainId, verifyingContract)),
        bytes32Word(reportStructHash(report)),
      ]),
    ),
  );
}

/** Clé d'idempotence : `keccak256(abi.encode(policyVersion, epoch, nonce, ordersCommitment))`. */
export function reportId(report: OnchainReport): string {
  return toHex(
    keccak256(
      concat([
        word(report.policyVersion),
        word(report.epoch),
        word(report.nonce),
        bytes32Word(report.ordersCommitment),
      ]),
    ),
  );
}
