/**
 * Produces the conformance fixture shared by the engine and the contracts.
 *
 *   node engine/scripts/fixtures.ts
 *
 * The generated file is read by a Solidity suite that recomputes everything on its side.
 * Two independent implementations of the same encoding, cross-checked on every test run:
 * it is the only way to catch a divergence before a report gets rejected in production
 * over a comma in a type signature.
 */

import { writeFileSync } from 'node:fs';
import {
  EIP712_DOMAIN_TYPE_STRING,
  REPORT_TYPE_STRING,
  ordersCommitment,
  reportId,
  reportStructHash,
  typeHash,
} from '../src/onchain/abi.ts';
import type { OnchainOrder, OnchainReport } from '../src/onchain/abi.ts';
import { ALLOWED_CALLS, selector } from '../../privy/src/policies.ts';

const salt = `0x${'ab'.repeat(32)}`;

const orders: OnchainOrder[] = [
  {
    sell: '0x1111111111111111111111111111111111111111',
    buy: '0x2222222222222222222222222222222222222222',
    amountIn: 500_000_000_000n,
    minAmountOut: 0n,
  },
  {
    sell: '0x3333333333333333333333333333333333333333',
    buy: '0x1111111111111111111111111111111111111111',
    amountIn: 250_000_000_000n,
    minAmountOut: 7n,
  },
];

const commitment = ordersCommitment(orders, salt);

// Risk metrics are signed integers: a negative value checks that sign extension to 256
// bits is done correctly on both sides. It is the encoding case easiest to get wrong and
// quietest when you do.
const report: OnchainReport = {
  epoch: 100n,
  nonce: 7n,
  expiry: 1_800_000_000n,
  inputsTimestamp: 1_799_999_940n,
  policyVersion: 3n,
  bandParamsHash: `0x${'11'.repeat(32)}`,
  inputsHash: `0x${'22'.repeat(32)}`,
  ordersCommitment: commitment,
  esBeforeBps: 120n,
  esAfterBps: -45n,
  costEstimate: 42_000_000n,
  grossNotional: 750_000_000_000n,
};

const fixture = {
  salt,
  orders: orders.map((o) => ({
    sell: o.sell,
    buy: o.buy,
    amountIn: Number(o.amountIn),
    minAmountOut: Number(o.minAmountOut),
  })),
  ordersCommitment: commitment,
  report: {
    epoch: Number(report.epoch),
    nonce: Number(report.nonce),
    expiry: Number(report.expiry),
    inputsTimestamp: Number(report.inputsTimestamp),
    policyVersion: Number(report.policyVersion),
    bandParamsHash: report.bandParamsHash,
    inputsHash: report.inputsHash,
    ordersCommitment: report.ordersCommitment,
    esBeforeBps: Number(report.esBeforeBps),
    esAfterBps: Number(report.esAfterBps),
    costEstimate: Number(report.costEstimate),
    grossNotional: Number(report.grossNotional),
  },
  reportTypeHash: typeHash(REPORT_TYPE_STRING),
  domainTypeHash: typeHash(EIP712_DOMAIN_TYPE_STRING),
  reportStructHash: reportStructHash(report),
  reportId: reportId(report),
};

// Selectors of the functions the Privy policies allow. A mistyped signature would produce
// a policy that blocks exactly what it was meant to permit, and the error would only
// surface as an approval refused in the middle of a demo. The Solidity suite checks them
// against the compiled contracts.
const selectors = Object.fromEntries(
  Object.entries(ALLOWED_CALLS).flatMap(([role, signatures]) =>
    signatures.map((sig) => [sig, { role, selector: selector(sig) }]),
  ),
);
Object.assign(fixture as Record<string, unknown>, { selectors });

const target = new URL('../../contracts/test/fixtures/conformance.json', import.meta.url);
writeFileSync(target, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`conformance fixture written: ${target.pathname}`);
console.log(`  commitment  ${fixture.ordersCommitment}`);
console.log(`  structHash  ${fixture.reportStructHash}`);
console.log(`  reportId    ${fixture.reportId}`);
