/** Tests des politiques Privy — la seconde couche de contrôle. */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ALLOWED_CALLS, QUORUM, buildAllPolicies, buildPolicy, selector } from '../src/policies.ts';
import type { Role } from '../src/policies.ts';
import { VAULT_ABI_FRAGMENT } from '../src/abi.ts';

const VAULT = '0x0DCd1Bf9A1b36cE34237eEaFef220932846BCD82';
const POLICY = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const TARGETS = { vault: VAULT, treasuryPolicy: POLICY, abi: VAULT_ABI_FRAGMENT };
const ROLES: readonly Role[] = ['OPERATOR', 'TREASURER', 'RISK_OFFICER'];

describe('sélecteurs', () => {
  /**
   * Ces valeurs viennent de `forge inspect ... methodIdentifiers` sur les contrats
   * compilés. Une suite Solidity les confronte au bytecode à chaque exécution ; ce
   * test-ci verrouille le versant TypeScript, pour qu'une signature retouchée ici ne
   * passe pas inaperçue.
   */
  test('correspondent aux contrats compilés', () => {
    assert.equal(selector('approve(bytes32)'), '0xa53a1adf');
    assert.equal(selector('commitBandParams(bytes32)'), '0x97b00759');
    assert.equal(
      selector('execute(bytes32,(address,address,uint128,uint128)[],bytes32)'),
      '0xfc8d9160',
    );
  });

  test('chaque sélecteur fait quatre octets', () => {
    for (const signatures of Object.values(ALLOWED_CALLS)) {
      for (const s of signatures) assert.match(selector(s), /^0x[0-9a-f]{8}$/);
    }
  });
});

describe('séparation des devoirs, seconde couche', () => {
  const policies = buildAllPolicies(TARGETS);

  /**
   * Le contrat impose déjà la séparation des devoirs. Pourquoi la redire ici ?
   *
   * Parce que les deux couches échouent différemment. Le contrat protège contre un
   * opérateur qui tenterait une action interdite ; la politique protège contre une clé
   * **compromise** qui signerait autre chose — un transfert vers une adresse
   * arbitraire, un appel à un contrat étranger. Le contrat ne voit jamais ces
   * transactions-là et n'a aucun moyen de les empêcher.
   */
  test('aucun rôle ne peut approuver hormis le trésorier', () => {
    const approveSelector = selector('approve(bytes32)');
    for (const role of ROLES) {
      const allowed = ALLOWED_CALLS[role].map(selector);
      assert.equal(
        allowed.includes(approveSelector),
        role === 'TREASURER',
        `${role} et l'approbation`,
      );
    }
  });

  test('le trésorier ne peut rien faire d’autre qu’approuver', () => {
    assert.equal(ALLOWED_CALLS.TREASURER.length, 1);
  });

  test('le responsable des risques ne vise pas le coffre', () => {
    const rule = policies.RISK_OFFICER.rules[0]!;
    const to = rule.conditions.find((c) => c.field === 'to');
    assert.equal(to?.value, POLICY);
  });

  test('opérateur et trésorier visent le coffre', () => {
    for (const role of ['OPERATOR', 'TREASURER'] as const) {
      const to = policies[role].rules[0]!.conditions.find((c) => c.field === 'to');
      assert.equal(to?.value, VAULT);
    }
  });
});

describe('forme des politiques', () => {
  const policies = buildAllPolicies(TARGETS);

  test('chaque politique se termine par un refus explicite', () => {
    for (const role of ROLES) {
      const rules = policies[role].rules;
      const last = rules[rules.length - 1]!;
      assert.equal(last.action, 'DENY');
      assert.equal(last.conditions.length, 0, 'le refus final ne doit rien conditionner');
    }
  });

  /**
   * La condition qu'on oublie. Un portefeuille autorisé à *appeler* un contrat reste
   * autorisé à lui **envoyer** de la valeur — et sur Arc le gaz est de l'USDC, donc la
   * valeur native est de l'argent.
   */
  test('aucun rôle ne peut transférer de valeur native', () => {
    for (const role of ROLES) {
      const value = policies[role].rules[0]!.conditions.find((c) => c.field === 'value');
      assert.ok(value, `${role} : aucune contrainte de valeur`);
      assert.equal(value!.operator, 'eq');
      assert.equal(value!.value, '0');
    }
  });

  test('la calldata est contrainte et l’ABI fournie', () => {
    for (const role of ROLES) {
      const calldata = policies[role].rules[0]!.conditions.find(
        (c) => c.field_source === 'ethereum_calldata',
      );
      assert.ok(calldata, `${role} : aucune contrainte de calldata`);
      assert.ok(calldata!.abi, 'Privy exige une ABI pour décoder la calldata');
      assert.deepEqual(calldata!.value, ALLOWED_CALLS[role].map(selector));
    }
  });

  test('la version et le type de chaîne sont ceux attendus par l’API', () => {
    for (const role of ROLES) {
      assert.equal(policies[role].version, '1.0');
      assert.equal(policies[role].chain_type, 'ethereum');
    }
  });

  test('changer d’adresse de coffre change la politique', () => {
    const other = buildPolicy('OPERATOR', { ...TARGETS, vault: POLICY });
    assert.notDeepEqual(other, policies.OPERATOR);
  });
});

describe('quorum', () => {
  /**
   * Un seul rôle exige deux clés : le trésorier. C'est le geste le plus lourd de
   * conséquences du système, et le seul dont le ralentissement soit justifié. Un quorum
   * sur l'opérateur alourdirait chaque epoch de quinze minutes sans rien protéger que
   * le contrat ne protège déjà.
   */
  test('seul le trésorier exige plusieurs signatures', () => {
    assert.ok(QUORUM.TREASURER.threshold > 1);
    assert.equal(QUORUM.OPERATOR.threshold, 1);
  });

  test('aucun seuil n’excède le nombre de clés', () => {
    for (const role of ROLES) {
      assert.ok(QUORUM[role].threshold <= QUORUM[role].keys, `${role} : quorum impossible`);
      assert.ok(QUORUM[role].threshold >= 1);
    }
  });
});
