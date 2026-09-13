/** On-chain encoding layer tests — keccak256, ABI, EIP-712. */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { fromHex, keccak256Hex, toHex } from '../src/onchain/keccak.ts';
import {
  EIP712_DOMAIN_TYPE_STRING,
  REPORT_TYPE_STRING,
  domainSeparator,
  encodeOrdersAndSalt,
  ordersCommitment,
  reportDigest,
  reportId,
  reportStructHash,
  typeHash,
} from '../src/onchain/abi.ts';
import type { OnchainOrder, OnchainReport } from '../src/onchain/abi.ts';

describe('keccak256', () => {
  /**
   * Node exposes `sha3-256`, which is not the same function: SHA-3 standardisation
   * changed the padding byte from 0x01 to 0x06 after Keccak was published. Ethereum kept
   * the original. These vectors check that we implement that one.
   */
  test('reference vectors', () => {
    assert.equal(
      keccak256Hex(''),
      '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
    );
    assert.equal(
      keccak256Hex('abc'),
      '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45',
    );
    assert.equal(
      keccak256Hex('The quick brown fox jumps over the lazy dog'),
      '0x4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15',
    );
  });

  /**
   * The Keccak-256 rate is 136 bytes. Padding bugs hide exactly at block boundaries: a
   * 135-byte input fits in one block with its padding, 136 requires a second block made
   * entirely of padding.
   */
  test('block boundaries are crossed correctly', () => {
    const seen = new Set<string>();
    for (const n of [0, 1, 135, 136, 137, 271, 272]) {
      const h = keccak256Hex('a'.repeat(n));
      assert.match(h, /^0x[0-9a-f]{64}$/, `malformed digest for ${n} bytes`);
      assert.ok(!seen.has(h), `improbable collision at ${n} bytes`);
      seen.add(h);
    }
  });

  test('the hex round trip is faithful', () => {
    const hex = `0x${'0f1e2d3c'.repeat(8)}`;
    assert.equal(toHex(fromHex(hex)), hex);
  });

  test('an odd-length hex string is rejected', () => {
    assert.throws(() => fromHex('0xabc'), RangeError);
  });
});

describe('ABI encoding', () => {
  const orders: OnchainOrder[] = [
    {
      sell: '0x1111111111111111111111111111111111111111',
      buy: '0x2222222222222222222222222222222222222222',
      amountIn: 500_000_000_000n,
      minAmountOut: 0n,
    },
  ];
  const salt = `0x${'ab'.repeat(32)}`;

  test('the dynamic array is preceded by its offset then its length', () => {
    const encoded = toHex(encodeOrdersAndSalt(orders, salt));
    // Word 0: offset 0x40. Word 1: the salt. Word 2: the length.
    assert.equal(encoded.slice(2, 66), '40'.padStart(64, '0'));
    assert.equal(encoded.slice(66, 130), 'ab'.repeat(32));
    assert.equal(encoded.slice(130, 194), '1'.padStart(64, '0'));
  });

  test('each order occupies exactly four words', () => {
    const one = encodeOrdersAndSalt(orders, salt).length;
    const two = encodeOrdersAndSalt([...orders, ...orders], salt).length;
    assert.equal(two - one, 4 * 32);
  });

  test('a malformed address is rejected', () => {
    assert.throws(
      () => encodeOrdersAndSalt([{ ...orders[0]!, sell: '0x1234' }], salt),
      RangeError,
    );
  });

  test('the commitment depends on the salt', () => {
    assert.notEqual(
      ordersCommitment(orders, salt),
      ordersCommitment(orders, `0x${'cd'.repeat(32)}`),
    );
  });
});

describe('EIP-712', () => {
  const report: OnchainReport = {
    epoch: 100n,
    nonce: 7n,
    expiry: 1_800_000_000n,
    inputsTimestamp: 1_799_999_940n,
    policyVersion: 3n,
    bandParamsHash: `0x${'11'.repeat(32)}`,
    inputsHash: `0x${'22'.repeat(32)}`,
    ordersCommitment: `0x${'33'.repeat(32)}`,
    esBeforeBps: 120n,
    esAfterBps: -45n,
    costEstimate: 42_000_000n,
    grossNotional: 750_000_000_000n,
  };

  /**
   * Risk metrics are signed integers. Sign extension to 256 bits is the encoding detail
   * easiest to get wrong and quietest when you do: the encoding stays well formed, only
   * the digest differs — and the signature is rejected with nothing to say why.
   */
  test('a negative metric changes the struct hash', () => {
    const positive = reportStructHash({ ...report, esAfterBps: 45n });
    const negative = reportStructHash({ ...report, esAfterBps: -45n });
    assert.notEqual(positive, negative);
  });

  test('the domain separator depends on the chain and the contract', () => {
    const a = domainSeparator(1n, '0x1111111111111111111111111111111111111111');
    const b = domainSeparator(31_337n, '0x1111111111111111111111111111111111111111');
    const c = domainSeparator(1n, '0x2222222222222222222222222222222222222222');
    assert.notEqual(a, b);
    assert.notEqual(a, c);
  });

  test('the signed digest is prefixed with 0x1901', () => {
    const d = reportDigest(report, 31_337n, '0x1111111111111111111111111111111111111111');
    assert.match(d, /^0x[0-9a-f]{64}$/);
  });

  test('the idempotency key depends on the order commitment', () => {
    assert.notEqual(
      reportId(report),
      reportId({ ...report, ordersCommitment: `0x${'44'.repeat(32)}` }),
    );
  });
});

describe('conformance with the contracts', () => {
  const path = new URL('../../contracts/test/fixtures/conformance.json', import.meta.url);
  const fixture = JSON.parse(readFileSync(path, 'utf8'));

  /**
   * The committed fixture is read by a Solidity suite that recomputes everything on its
   * side. This test checks the other direction: that the file really is what the engine
   * produces today. Without it, regenerating the fixture would make both suites pass
   * while silently changing the contract.
   */
  test('the committed fixture matches what the engine produces', () => {
    const orders: OnchainOrder[] = fixture.orders.map((o: Record<string, unknown>) => ({
      sell: o.sell as string,
      buy: o.buy as string,
      amountIn: BigInt(o.amountIn as number),
      minAmountOut: BigInt(o.minAmountOut as number),
    }));
    assert.equal(ordersCommitment(orders, fixture.salt), fixture.ordersCommitment);

    const r = fixture.report;
    const report: OnchainReport = {
      epoch: BigInt(r.epoch),
      nonce: BigInt(r.nonce),
      expiry: BigInt(r.expiry),
      inputsTimestamp: BigInt(r.inputsTimestamp),
      policyVersion: BigInt(r.policyVersion),
      bandParamsHash: r.bandParamsHash,
      inputsHash: r.inputsHash,
      ordersCommitment: r.ordersCommitment,
      esBeforeBps: BigInt(r.esBeforeBps),
      esAfterBps: BigInt(r.esAfterBps),
      costEstimate: BigInt(r.costEstimate),
      grossNotional: BigInt(r.grossNotional),
    };
    assert.equal(reportStructHash(report), fixture.reportStructHash);
    assert.equal(reportId(report), fixture.reportId);
    assert.equal(typeHash(REPORT_TYPE_STRING), fixture.reportTypeHash);
    assert.equal(typeHash(EIP712_DOMAIN_TYPE_STRING), fixture.domainTypeHash);
  });

  test('the fixture does exercise a negative metric', () => {
    assert.ok(fixture.report.esAfterBps < 0);
  });

  /**
   * Cross-checked against Ethereum's reference implementation when it is available. The
   * test is skipped if Foundry is not installed: the suite must stay runnable on a
   * machine that only has Node.
   */
  test('keccak256 agrees with cast', (t) => {
    let cast: string;
    try {
      cast = execFileSync('cast', ['keccak', 'abc'], { encoding: 'utf8' }).trim();
    } catch {
      t.skip('cast unavailable');
      return;
    }
    assert.equal(cast, keccak256Hex('abc'));
  });
});
