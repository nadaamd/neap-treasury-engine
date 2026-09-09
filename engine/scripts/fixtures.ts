/**
 * Produit le jeu de conformité partagé entre le moteur et les contrats.
 *
 *   node engine/scripts/fixtures.ts
 *
 * Le fichier engendré est lu par une suite Solidity qui recalcule tout de son côté. Deux
 * implémentations indépendantes du même encodage, confrontées à chaque exécution des
 * tests : c'est la seule façon d'attraper une divergence avant qu'un rapport ne soit
 * rejeté en production pour une virgule dans une signature de type.
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

// Les métriques de risque sont signées : une valeur négative vérifie que l'extension de
// signe sur 256 bits est bien faite des deux côtés. C'est le cas d'encodage le plus
// facile à rater et le plus silencieux quand on le rate.
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

const target = new URL('../../contracts/test/fixtures/conformance.json', import.meta.url);
writeFileSync(target, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`jeu de conformité écrit : ${target.pathname}`);
console.log(`  commitment  ${fixture.ordersCommitment}`);
console.log(`  structHash  ${fixture.reportStructHash}`);
console.log(`  reportId    ${fixture.reportId}`);
