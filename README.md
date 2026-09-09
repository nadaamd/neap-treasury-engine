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

## Documentation

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
