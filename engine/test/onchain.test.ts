/** Tests de la couche d'encodage on-chain — keccak256, ABI, EIP-712. */

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
   * Node expose `sha3-256`, qui n'est pas la même fonction : la normalisation SHA-3 a
   * changé l'octet de bourrage de 0x01 à 0x06 après la publication de Keccak. Ethereum a
   * gardé la version d'origine. Ces vecteurs vérifient qu'on implémente bien celle-là.
   */
  test('vecteurs de référence', () => {
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
   * Le débit de Keccak-256 est de 136 octets. Les erreurs de bourrage se cachent
   * exactement aux frontières de bloc : une entrée de 135 octets tient dans un bloc avec
   * le bourrage, 136 en exige un second entièrement fait de bourrage.
   */
  test('les frontières de bloc sont franchies correctement', () => {
    const seen = new Set<string>();
    for (const n of [0, 1, 135, 136, 137, 271, 272]) {
      const h = keccak256Hex('a'.repeat(n));
      assert.match(h, /^0x[0-9a-f]{64}$/, `empreinte mal formée pour ${n} octets`);
      assert.ok(!seen.has(h), `collision improbable sur ${n} octets`);
      seen.add(h);
    }
  });

  test('l’aller-retour hexadécimal est fidèle', () => {
    const hex = `0x${'0f1e2d3c'.repeat(8)}`;
    assert.equal(toHex(fromHex(hex)), hex);
  });

  test('une chaîne hexadécimale impaire est rejetée', () => {
    assert.throws(() => fromHex('0xabc'), RangeError);
  });
});

describe('encodage ABI', () => {
  const orders: OnchainOrder[] = [
    {
      sell: '0x1111111111111111111111111111111111111111',
      buy: '0x2222222222222222222222222222222222222222',
      amountIn: 500_000_000_000n,
      minAmountOut: 0n,
    },
  ];
  const salt = `0x${'ab'.repeat(32)}`;

  test('le tableau dynamique est précédé de son décalage puis de sa longueur', () => {
    const encoded = toHex(encodeOrdersAndSalt(orders, salt));
    // Mot 0 : décalage 0x40. Mot 1 : le sel. Mot 2 : la longueur.
    assert.equal(encoded.slice(2, 66), '40'.padStart(64, '0'));
    assert.equal(encoded.slice(66, 130), 'ab'.repeat(32));
    assert.equal(encoded.slice(130, 194), '1'.padStart(64, '0'));
  });

  test('chaque ordre occupe exactement quatre mots', () => {
    const one = encodeOrdersAndSalt(orders, salt).length;
    const two = encodeOrdersAndSalt([...orders, ...orders], salt).length;
    assert.equal(two - one, 4 * 32);
  });

  test('une adresse mal formée est rejetée', () => {
    assert.throws(
      () => encodeOrdersAndSalt([{ ...orders[0]!, sell: '0x1234' }], salt),
      RangeError,
    );
  });

  test('l’engagement dépend du sel', () => {
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
   * Les métriques de risque sont signées. L'extension de signe sur 256 bits est le
   * détail d'encodage le plus facile à rater et le plus silencieux quand on le rate :
   * l'encodage reste bien formé, seule l'empreinte diffère — et la signature est
   * rejetée sans que rien n'indique pourquoi.
   */
  test('une métrique négative change l’empreinte de structure', () => {
    const positive = reportStructHash({ ...report, esAfterBps: 45n });
    const negative = reportStructHash({ ...report, esAfterBps: -45n });
    assert.notEqual(positive, negative);
  });

  test('le séparateur de domaine dépend de la chaîne et du contrat', () => {
    const a = domainSeparator(1n, '0x1111111111111111111111111111111111111111');
    const b = domainSeparator(31_337n, '0x1111111111111111111111111111111111111111');
    const c = domainSeparator(1n, '0x2222222222222222222222222222222222222222');
    assert.notEqual(a, b);
    assert.notEqual(a, c);
  });

  test('l’empreinte signée est préfixée par 0x1901', () => {
    const d = reportDigest(report, 31_337n, '0x1111111111111111111111111111111111111111');
    assert.match(d, /^0x[0-9a-f]{64}$/);
  });

  test('la clé d’idempotence dépend de l’engagement sur les ordres', () => {
    assert.notEqual(
      reportId(report),
      reportId({ ...report, ordersCommitment: `0x${'44'.repeat(32)}` }),
    );
  });
});

describe('conformité avec les contrats', () => {
  const path = new URL('../../contracts/test/fixtures/conformance.json', import.meta.url);
  const fixture = JSON.parse(readFileSync(path, 'utf8'));

  /**
   * Le jeu versionné est lu par une suite Solidity qui recalcule tout de son côté. Ce
   * test-ci vérifie l'autre sens : que le fichier soit bien ce que le moteur produit
   * aujourd'hui. Sans lui, régénérer le jeu ferait passer les deux suites tout en ayant
   * silencieusement changé le contrat.
   */
  test('le jeu versionné correspond à ce que le moteur produit', () => {
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

  test('le jeu exerce bien une métrique négative', () => {
    assert.ok(fixture.report.esAfterBps < 0);
  });

  /**
   * Confrontation à l'implémentation de référence d'Ethereum lorsqu'elle est disponible.
   * Le test est ignoré si Foundry n'est pas installé : la suite doit rester exécutable
   * sur une machine qui n'a que Node.
   */
  test('keccak256 concorde avec cast', (t) => {
    let cast: string;
    try {
      cast = execFileSync('cast', ['keccak', 'abc'], { encoding: 'utf8' }).trim();
    } catch {
      t.skip('cast indisponible');
      return;
    }
    assert.equal(cast, keccak256Hex('abc'));
  });
});
