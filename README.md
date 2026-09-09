# FLOAT — Intraday Multi-Currency Treasury Engine

> ETHOnline 2026 · Arc (Circle) · Chainlink CRE · Privy

Une institution qui promet des paiements transfrontaliers instantanés doit pré-financer chaque
devise de chaque corridor. Ce capital est immobilisé, non rémunéré, et porte une exposition de
change subie.

**FLOAT** remplace ce pré-financement statique par un moteur de contrôle stochastique : il prévoit
les flux nets par corridor, résout les bandes de rééquilibrage optimales par devise, et ne
déclenche une exécution PvP sur le moteur FX d'Arc que lorsque le gain marginal (capital libéré +
réduction d'Expected Shortfall) dépasse le coût marginal d'exécution.

Le calcul de risque tourne dans un handler confidentiel **Chainlink CRE (TEE)** — aucune
institution ne publiera ses positions de trésorerie en clair sur une chaîne publique. La
gouvernance opérationnelle repose sur les org wallets **Privy**, avec séparation des devoirs
imposée on-chain.

## La thèse, en un paragraphe

Le coût fixe d'un rééquilibrage sur Arc est de l'ordre de quelques cents en USDC, avec une
finalité de ~350 ms. Dans le modèle de Miller-Orr, la largeur de bande optimale croît en
`γ^(1/3)` où `γ` est ce coût fixe. Diviser `γ` par 10 000 réduit la bande d'un facteur ~21.
**Le buffer de trésorerie optimal s'effondre.** Ce projet quantifie cet effondrement, par backtest
walk-forward avec intervalles de confiance.

## Lancer

```bash
npm run dev        # tableau de bord sur http://localhost:5173
npm test           # 109 tests TypeScript, aucune dépendance
npm run backtest   # régénère results/backtest.json (~9 min)
cd contracts && forge test   # 80 tests Solidity
```

Aucun `npm install` : Node 24 exécute le TypeScript nativement et le dépôt n'a pas de
dépendance JavaScript. Les contrats utilisent Foundry et `forge-std` en sous-module.

## Résultats

Backtest walk-forward, 20 germes × 6 fenêtres, calibration sur le passé strict
([`docs/BACKTEST.md`](./docs/BACKTEST.md)) :

| | Pré-financement conservateur | FLOAT | Écart |
|---|---|---|---|
| Capital immobilisé | 1,74 M$ | **269 k$** | **−84,6 %** |
| ES 97,5 % | 77,8 k$ | **8,2 k$** | **−89,4 %** |
| Coût total | 356 k$ | **269 k$** | −24,4 % |
| Nombre d'ordres | 90 | 2 879 | +3 113 % |

La réduction de capital est stable sur toute la plage de sensibilité au seul paramètre
non calibré du modèle. La réduction de coût, elle, en dépend (−13 % à −38 %) et ne doit
jamais être citée sans sa plage.

Le mécanisme n'est pas celui qu'on attend : le coût d'exécution baisse **malgré** trente
fois plus d'ordres, parce que sous impact en racine carrée beaucoup de petits ordres
coûtent moins que quelques gros. Ce régime n'est accessible que parce que le coût fixe
d'un rééquilibrage s'est effondré sur le rail stablecoin.

## Documentation

- [`docs/BACKTEST.md`](./docs/BACKTEST.md) — résultats du backtest, avec leurs limites
- [`docs/DECISIONS.md`](./docs/DECISIONS.md) — journal des décisions d'architecture
- [`SPEC.md`](./SPEC.md) — spécification technique complète : périmètre, modèle quantitatif,
  architecture, contrats, sécurité, problématiques ouvertes et décisions arrêtées.

## Statut

🚧 En cours de construction — ETHOnline 2026.

## Ce qui est réel / ce qui est simulé

Section maintenue à jour par honnêteté envers les juges et les lecteurs :

| Composant | Statut |
|---|---|
| Données de flux de paiement | **synthétiques** — générateur Poisson composé calibré sur agrégats publics (BCE, Banque Mondiale) |
| Coefficient d'impact de marché `η` | **non calibré** — exposé en paramètre, sensibilité affichée |
| Venue d'exécution | `MockFxVenue` déterministe pour le backtest, `ArcFxVenue` pour l'intégration réelle |
| Attestation TEE | à confirmer — déploiement CRE réel visé, runner local isolé en repli documenté |

## Licence

MIT
