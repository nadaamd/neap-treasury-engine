# Jalon 0 — Questions bloquantes aux sponsors

> À poser dès l'ouverture des canaux Discord. Aucune réponse négative ne tue le projet
> (cf. décisions D8 et D9), mais chacune change le chemin d'implémentation.

## Chainlink CRE

- [ ] Les **TEE handlers** sont-ils accessibles en testnet public sans allowlist ? Quotas ?
- [ ] Quel runtime pour le handler (Go / TypeScript / WASM) ? Quelles bibliothèques disponibles ?
- [ ] **Arc est-il une chaîne de destination supportée par CRE ?** → si non, pont ou relais nécessaire
- [ ] Format de l'attestation : un contrat peut-il la vérifier on-chain à coût raisonnable ?
- [ ] Comment les secrets (clé de déchiffrement) sont-ils fournis au handler ? Qui les détient ?
- [ ] Temps d'exécution max, taille max des inputs ?

**Réponses :**
_(à remplir)_

## Arc (Circle)

- [ ] Le **moteur FX RFQ** est-il appelable par un contrat de développeur en testnet, ou réservé
      à des market makers whitelistés ?
- [ ] Le règlement **PvP est-il atomique** du point de vue du contrat appelant ?
      → détermine si l'état `COMPENSATED` de la machine à états existe (§16.5)
- [ ] Liquidité EURC/USDC réelle en testnet ? Faucet ?
- [ ] **Transferts confidentiels** : primitives exactes, appelables depuis un contrat, surcoût gas,
      compatibles avec le RFQ ?
- [ ] Y a-t-il un **mempool public** ? Un rééquilibrage annoncé est-il front-runnable ?
- [ ] Estimation de gas fiable **avant** exécution (le coût est un terme de la fonction objectif) ?

**Réponses :**
_(à remplir)_

## Privy

- [ ] Les org wallets supportent-ils une **chaîne EVM arbitraire par chain ID** (donc Arc) ?
- [ ] Le **quorum m-sur-n** est-il natif, ou seulement des policies mono-signataire ?
      → sans impact bloquant : l'autorité est portée par le contrat (D7), Privy est défense
        en profondeur
- [ ] Les policies permettent-elles des **limites de vélocité** sur fenêtre glissante ?
- [ ] Export du journal d'approbations (pour la piste d'audit) ?

**Réponses :**
_(à remplir)_
