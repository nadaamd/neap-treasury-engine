/** Tests de la fonction de décision — SPEC §4.1, décisions D5, D6, D9. */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { RISK_CURRENCIES, simulateMarket } from '../../data/src/market.ts';
import { standardizedResiduals } from '../src/risk/residuals.ts';
import { canonicalizeOrders, decide } from '../src/policy/decide.ts';
import type { Commitment, CurrencyPolicy, DecisionInput } from '../src/policy/decide.ts';
import type { Currency } from '../../data/src/types.ts';

const MARKET = simulateMarket(4242, 800);
const { residuals, currentVol } = standardizedResiduals(MARKET.returns, RISK_CURRENCIES);

const NOW = Date.UTC(2026, 8, 9, 12, 0, 0);

const costs = {
  gammaFixed: 0.02,
  spreadBps: 2,
  etaImpact: 0.05,
  depth: 5_000_000,
  carryRate: 0.06 / 365 / 96,
  kappa: 0.1,
  esPerUnit: 0.001,
  breachCost: 50_000,
};

function policy(over: Partial<CurrencyPolicy> = {}): CurrencyPolicy {
  return {
    bands: { lower: 400_000, target: 600_000, upper: 900_000 },
    costs,
    maxSingleOrder: 2_000_000,
    settlementDays: 1 / 96,
    ...over,
  };
}

function input(over: Partial<DecisionInput> = {}): DecisionInput {
  return {
    epoch: 100,
    nonce: 7,
    policyVersion: 3,
    bandParamsHash: '0xabc',
    numeraire: 'USD',
    currencies: RISK_CURRENCIES as readonly Currency[],
    balances: { USD: 10_000_000, EUR: 600_000, GBP: 600_000, BRL: 600_000 },
    commitments: [],
    policies: { EUR: policy(), GBP: policy(), BRL: policy({ settlementDays: 2 }) },
    risk: {
      horizonDays: 1 / 96,
      alpha: 0.975,
      basisHaircutBps: 50,
      lotSize: 10_000,
      minOrder: 20_000,
      autoApproveThreshold: 1_000_000,
      maxPerEpoch: 5_000_000,
      fundingFloor: 1_000_000,
    },
    currentVol,
    residuals,
    marketTimestamp: NOW - 5_000,
    now: NOW,
    maxStalenessSec: 60,
    ...over,
  };
}

describe('garde-fous', () => {
  test('des données de marché périmées font rejeter la décision', () => {
    const d = decide(input({ marketTimestamp: NOW - 600_000 }));
    assert.equal(d.status, 'REJECTED');
    assert.match(d.reason, /périmées/);
    assert.equal(d.orders.length, 0);
  });

  test('un horodatage de marché dans le futur est également rejeté', () => {
    const d = decide(input({ marketTimestamp: NOW + 60_000 }));
    assert.equal(d.status, 'REJECTED');
  });

  test('l’enveloppe est recopiée telle quelle — anti-rejeu côté contrat', () => {
    const d = decide(input());
    assert.equal(d.epoch, 100);
    assert.equal(d.nonce, 7);
    assert.equal(d.policyVersion, 3);
    assert.equal(d.bandParamsHash, '0xabc');
  });
});

describe('règle de décision — la bande, et rien d’autre', () => {
  test('à l’intérieur des bandes, aucune action', () => {
    const d = decide(input());
    assert.equal(d.status, 'NOOP');
    assert.equal(d.orders.length, 0);
  });

  test('sous le seuil bas, on rachète jusqu’à la cible', () => {
    const d = decide(input({ balances: { USD: 10_000_000, EUR: 100_000, GBP: 600_000, BRL: 600_000 } }));
    assert.equal(d.status, 'PROPOSE');
    assert.equal(d.orders.length, 1);
    assert.deepEqual(d.orders[0], { sell: 'USD', buy: 'EUR', amount: 500_000 });
  });

  test('au-dessus du seuil haut, on dégage l’excédent', () => {
    const d = decide(input({ balances: { USD: 10_000_000, EUR: 1_500_000, GBP: 600_000, BRL: 600_000 } }));
    assert.deepEqual(d.orders[0], { sell: 'EUR', buy: 'USD', amount: 900_000 });
  });

  test('plusieurs devises hors bande produisent plusieurs ordres', () => {
    const d = decide(input({ balances: { USD: 10_000_000, EUR: 100_000, GBP: 1_500_000, BRL: 600_000 } }));
    assert.equal(d.orders.length, 2);
  });

  /**
   * Propriété structurelle : la cible étant strictement à l'intérieur de la bande,
   * tout franchissement produit un ordre d'au moins la plus petite demi-largeur —
   * ici min(cible − bas, haut − cible) = 200 k$. Un solde à 385 k$ n'engendre donc pas
   * un ordre de 15 k$ mais de 215 k$ : on revient à la cible, pas au seuil. C'est le
   * mécanisme de Miller-Orr, et c'est ce qui évite de rééquilibrer sans cesse au bord
   * de la bande.
   */
  test('franchir le seuil ramène à la cible, pas au seuil', () => {
    const d = decide(input({ balances: { USD: 10_000_000, EUR: 385_000, GBP: 600_000, BRL: 600_000 } }));
    // 600 000 − 385 000 = 215 000, quantifié vers le bas au lot de 10 000.
    assert.equal(d.orders[0]!.amount, 210_000);
  });

  test('le filtre de poussière s’applique après réduction, jamais avant', () => {
    const d = decide(
      input({
        balances: { USD: 1_010_000, EUR: 100_000, GBP: 600_000, BRL: 600_000 },
        risk: { ...input().risk, fundingFloor: 1_000_000, minOrder: 20_000 },
      }),
    );
    assert.equal(d.status, 'NOOP', 'un ordre réduit à 10 k$ est de la poussière et ne doit pas être émis');
  });
});

describe('engagements', () => {
  test('un engagement certain ampute le disponible et peut déclencher un ordre', () => {
    const commitments: Commitment[] = [
      { currency: 'EUR', amount: 300_000, dueEpoch: 101, certain: true },
    ];
    const d = decide(input({ commitments }));
    assert.equal(d.status, 'PROPOSE');
    assert.equal(d.orders[0]!.buy, 'EUR');
  });

  test('un engagement probable ne se déduit pas : il est déjà dans la distribution des bandes', () => {
    const commitments: Commitment[] = [
      { currency: 'EUR', amount: 300_000, dueEpoch: 101, certain: false },
    ];
    assert.equal(decide(input({ commitments })).status, 'NOOP');
  });

  test('un engagement hors horizon n’est pas déduit', () => {
    const commitments: Commitment[] = [
      { currency: 'EUR', amount: 300_000, dueEpoch: 500, certain: true },
    ];
    assert.equal(decide(input({ commitments })).status, 'NOOP');
  });
});

describe('quantification et plafonds (D6)', () => {
  test('les montants sont des multiples du pas de lot', () => {
    const d = decide(input({ balances: { USD: 10_000_000, EUR: 137_777, GBP: 600_000, BRL: 600_000 } }));
    assert.equal(d.orders[0]!.amount % 10_000, 0);
  });

  test('la quantification arrondit vers le bas, jamais vers le haut', () => {
    const d = decide(input({ balances: { USD: 10_000_000, EUR: 137_777, GBP: 600_000, BRL: 600_000 } }));
    assert.ok(d.orders[0]!.amount <= 600_000 - 137_777);
  });

  test('le plafond par ordre unitaire est respecté', () => {
    const d = decide(
      input({
        balances: { USD: 50_000_000, EUR: 0, GBP: 600_000, BRL: 600_000 },
        policies: { EUR: policy({ maxSingleOrder: 250_000 }), GBP: policy(), BRL: policy() },
      }),
    );
    assert.equal(d.orders[0]!.amount, 250_000);
  });

  test('le plafond de notionnel de l’epoch réduit le plan au prorata', () => {
    const d = decide(
      input({
        balances: { USD: 50_000_000, EUR: 0, GBP: 0, BRL: 0 },
        risk: { ...input().risk, maxPerEpoch: 900_000 },
      }),
    );
    const gross = d.orders.reduce((a, o) => a + o.amount, 0);
    assert.ok(gross <= 900_000, `notionnel ${gross} au-delà du plafond`);
    assert.match(d.reason, /plafond de notionnel/);
  });
});

describe('contrainte de financement', () => {
  test('on ne peut pas acheter au-delà du numéraire disponible, plancher préservé', () => {
    const d = decide(
      input({
        balances: { USD: 1_300_000, EUR: 0, GBP: 0, BRL: 0 },
        risk: { ...input().risk, fundingFloor: 1_000_000 },
      }),
    );
    const spent = d.orders.reduce((a, o) => a + (o.sell === 'USD' ? o.amount : 0), 0);
    assert.ok(spent <= 300_000, `dépense ${spent} au-delà du disponible`);
    assert.match(d.reason, /financement/);
  });

  test('le produit des ventes finance les achats du même epoch', () => {
    const d = decide(
      input({
        balances: { USD: 1_000_000, EUR: 0, GBP: 3_000_000, BRL: 600_000 },
        risk: { ...input().risk, fundingFloor: 1_000_000 },
      }),
    );
    const buy = d.orders.find((o) => o.buy === 'EUR');
    assert.ok(buy && buy.amount > 0, 'la vente de GBP aurait dû financer l’achat d’EUR');
  });
});

describe('approbation humaine', () => {
  test('sous le seuil, exécution automatique', () => {
    const d = decide(input({ balances: { USD: 10_000_000, EUR: 300_000, GBP: 600_000, BRL: 600_000 } }));
    assert.equal(d.requiresApproval, false);
  });

  test('au-dessus du seuil, approbation requise', () => {
    const d = decide(
      input({
        balances: { USD: 10_000_000, EUR: 0, GBP: 0, BRL: 600_000 },
        risk: { ...input().risk, autoApproveThreshold: 500_000 },
      }),
    );
    assert.equal(d.requiresApproval, true);
  });
});

describe('métriques de risque', () => {
  /**
   * Le réapprovisionnement **augmente** l'exposition de change, donc l'ES. Ce n'est pas
   * une anomalie : le solde pré-financé *est* la position directionnelle subie. La bande
   * a déjà arbitré ce surcroît de risque contre la réduction du risque de rupture, via
   * le terme κ·ES de la fonction objectif. Une décision qui ferait toujours baisser l'ES
   * serait une décision qui ignore le risque de rupture.
   */
  test('reconstituer un buffer augmente l’ES — et c’est le comportement attendu', () => {
    const d = decide(input({ balances: { USD: 10_000_000, EUR: 100_000, GBP: 600_000, BRL: 600_000 } }));
    assert.ok(
      d.metrics.esAfterBps > d.metrics.esBeforeBps,
      `ES ${d.metrics.esBeforeBps} → ${d.metrics.esAfterBps} bps`,
    );
  });

  test('dégager un excédent réduit l’ES', () => {
    const d = decide(input({ balances: { USD: 10_000_000, EUR: 3_000_000, GBP: 600_000, BRL: 600_000 } }));
    assert.ok(d.metrics.esAfterBps < d.metrics.esBeforeBps);
  });

  test('les métriques sont publiées en points de base, jamais en montant (D6)', () => {
    const d = decide(input({ balances: { USD: 10_000_000, EUR: 100_000, GBP: 600_000, BRL: 600_000 } }));
    for (const v of [d.metrics.esBeforeBps, d.metrics.esAfterBps, d.metrics.var99BeforeBps]) {
      assert.ok(Number.isInteger(v), `métrique non entière : ${v}`);
      assert.ok(Math.abs(v) < 2 ** 31, 'métrique hors capacité d’un int32');
    }
  });

  /**
   * Le corridor sans stablecoin se règle en J+2 : à montant égal, l'exposition reste
   * ouverte 192 fois plus longtemps qu'un règlement à finalité sub-seconde, donc le
   * risque d'exécution est ~√192 ≈ 14 fois supérieur. C'est le coût caché du rail lent,
   * et il ne se voit nulle part dans les frais affichés.
   */
  test('le rail lent porte un risque de règlement bien supérieur, à montant égal', () => {
    const fast = decide(
      input({
        balances: { USD: 20_000_000, EUR: 100_000, GBP: 600_000, BRL: 600_000 },
        policies: { EUR: policy(), GBP: policy(), BRL: policy() },
      }),
    );
    const slow = decide(
      input({
        balances: { USD: 20_000_000, EUR: 100_000, GBP: 600_000, BRL: 600_000 },
        policies: { EUR: policy({ settlementDays: 2 }), GBP: policy(), BRL: policy() },
      }),
    );
    assert.deepEqual(fast.orders, slow.orders, 'les plans doivent être identiques');
    assert.ok(
      slow.metrics.settlementRiskBps > 5 * fast.metrics.settlementRiskBps,
      `rail lent ${slow.metrics.settlementRiskBps} bps vs rapide ${fast.metrics.settlementRiskBps} bps`,
    );
  });

  test('le coût estimé couvre le coût fixe et le coût variable', () => {
    const d = decide(input({ balances: { USD: 10_000_000, EUR: 100_000, GBP: 600_000, BRL: 600_000 } }));
    assert.ok(d.metrics.costEstimate > costs.gammaFixed);
  });
});

describe('pureté et encodage canonique (D9, D6)', () => {
  test('mêmes entrées ⇒ mêmes sorties, à l’identique', () => {
    const i = input({ balances: { USD: 10_000_000, EUR: 100_000, GBP: 1_400_000, BRL: 600_000 } });
    assert.deepEqual(decide(i), decide(i));
  });

  test('l’encodage canonique ne dépend pas de l’ordre d’énumération', () => {
    const a = canonicalizeOrders([
      { sell: 'USD', buy: 'EUR', amount: 500_000 },
      { sell: 'GBP', buy: 'USD', amount: 200_000 },
    ]);
    const b = canonicalizeOrders([
      { sell: 'GBP', buy: 'USD', amount: 200_000 },
      { sell: 'USD', buy: 'EUR', amount: 500_000 },
    ]);
    assert.equal(a, b);
  });

  test('un montant différent produit un encodage différent — le commitment est liant', () => {
    const a = canonicalizeOrders([{ sell: 'USD', buy: 'EUR', amount: 500_000 }]);
    const b = canonicalizeOrders([{ sell: 'USD', buy: 'EUR', amount: 510_000 }]);
    assert.notEqual(a, b);
  });

  test('un NOOP ne publie aucun encodage', () => {
    assert.equal(decide(input()).ordersCanonical, '');
  });
});
