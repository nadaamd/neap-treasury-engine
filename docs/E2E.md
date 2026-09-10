# Scénario de bout en bout — trace de référence

> `npm run e2e`. Nœud local éphémère, comptes anvil déterministes.

```

01  Démarrage du nœud local
    bloc 0

02  Déploiement du système
    politique 0x5FbDB2315678afecb367f032d93F642f64180aa3
    vérificateur 0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0
    coffre 0x0DCd1Bf9A1b36cE34237eEaFef220932846BCD82

03  Séparation des devoirs — le contrat refuse le cumul
    refus : SeparationOfDutiesViolated
    le déployeur détient RISK_OFFICER, il ne peut donc pas être trésorier
    trésorier distinct : 0x70997970C51812dc3A010C7d01b50e0d17dc79C8
    signataire du DON : 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC

04  Le responsable des risques met la politique en file
    deux changements en attente, délai de 24 heures

05  Le délai s’écoule, puis les changements s’appliquent
    version de politique : 2

06  Approvisionnement du coffre
    USDC 20 000 000 · EURC 92 000
    équivalent 100 000 — sous le seuil bas de 400 000

07  Le moteur décide
    PROPOSE — 1 ordre
    acheter 458 620 EURC contre 500 000 USDC
    ES 6 → 36 bps · engagement 0x42fd8bf64d581856…

08  Signature du rapport par le quorum
    empreinte EIP-712 identique des deux côtés : 0x808c86a7abf3ab8e…

09  L’opérateur soumet le rapport
    plan 0xdc218c7e9e81719e… · état AwaitingApproval

10  Le notionnel dépasse le seuil : approbation humaine requise
    exécution refusée avant approbation : WrongStatus
    auto-approbation refusée : Unauthorized
    approuvé par le trésorier · état Ready

11  Exécution
    USDC 20 000 000 → 19 500 000   (-500 000)
    EURC 92 000 → 551 632   (+459 632)
    état Settled

12  Le rejeu est refusé
    refus : WrongStatus

13  Contrôles
    ✔ le plan est réglé
    ✔ le montant dépensé est celui du plan
    ✔ le montant reçu respecte le minimum
    ✔ le taux obtenu est proche du taux de référence

✔ Chaîne complète vérifiée : déploiement → politique → décision → signature → soumission → approbation → exécution

```
