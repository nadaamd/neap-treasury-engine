# Jalon 0 — réponses

> Mis à jour le 10 septembre 2026, après lecture des documentations officielles.
>
> Ces questions avaient été rédigées comme « bloquantes, à poser aux sponsors ». C'était
> une erreur de méthode : la quasi-totalité des réponses est publique. Ce document
> conserve les questions et leurs réponses sourcées ; les rares points réellement ouverts
> sont isolés à la fin.

---

## Chainlink — Confidential Workflows

**Le simulateur local ne demande aucune inscription.** ✅ *Le point le plus important.*
La documentation est explicite : « After submitting your request, you don't need to wait
for early access. Your CRE organization can run Confidential Workflows using the local
simulator. » Or le track ETHGlobal exige « successful simulation **or** deployment
proof ». Le prix est donc atteignable sans passer par une équipe commerciale.

**Ce que l'inscription ouvre exactement.** ⚠️ Précision obtenue en lisant le formulaire
lui-même, que la documentation ne donnait pas : l'approbation accorde **90 jours d'accès
testnet** avec capacités de lecture, d'écriture et de déclenchement. Ce n'est donc pas
seulement la production qui est fermée sans inscription, c'est le déploiement testnet.
Le simulateur reste ouvert. Prérequis : un **CRE organization ID** créé sur
cre.chain.link. Formulaire, champs et brouillons de réponse dans
[`CRE-ACCESS-FORM.md`](./CRE-ACCESS-FORM.md).

**API des handlers confidentiels.** ✅ `cre.HandlerInTee` en Go, `handlerInTee` en
TypeScript, avec un `TeeRuntime` passé au callback. On enregistre le handler destiné à
l'enclave en précisant les types et régions de TEE acceptés.

**Runtime.** ✅ Go et TypeScript. Le SDK TypeScript est `@chainlink/cre-sdk`, compilé
vers **WASM**, et `cre workflow simulate` exécute le workflow dans le même environnement
WASM qu'en production. La décision D11 — moteur en TypeScript, fonction pure sans E/S —
se révèle compatible sans retouche.

**Acheminement des secrets.** ✅ Par le **Vault DON**, qui libère les secrets dans
l'enclave. Ils sont « requested and decrypted inside the enclave at the moment your code
needs them » — déchiffrement au dernier moment plutôt que préchargement.

**Attestation.** ⚠️ Réponse différente de ce que l'architecture supposait : « DON
consensus verifies attestations from the enclave ». **C'est le DON qui vérifie
l'attestation, pas le contrat consommateur.** Le format n'est pas documenté et rien
n'indique qu'un contrat puisse la vérifier lui-même à coût raisonnable. Conséquence en
D23 ci-dessous.

**Limite à connaître.** ⚠️ « Workflow logic is not confidential » — seules les données
et les valeurs intermédiaires sont protégées. C'est exactement ce que NEAP demande : on
protège les positions, pas le modèle. Mais il faut le dire avant qu'un juge ne le
demande.

**Point encore ouvert.** ❓ Les chaînes de destination supportées par CRE ne sont pas
documentées, et donc le support d'Arc reste inconnu.

Sources : [Confidential Workflows](https://docs.chain.link/cre/concepts/confidential-workflows) ·
[Accès](https://docs.chain.link/cre/account/confidential-workflows-access) ·
[Runtime TypeScript/WASM](https://docs.chain.link/cre/concepts/typescript-wasm-runtime) ·
[@chainlink/cre-sdk](https://www.npmjs.com/package/@chainlink/cre-sdk)

---

## Circle / Arc — StableFX

Le moteur FX d'Arc porte un nom : **StableFX**. Le désigner correctement est le premier
signe qu'on a lu la documentation.

**Le règlement PvP est atomique.** ✅ « Smart contract escrow ensures atomic settlement
where both sides complete or neither does. » L'état `COMPENSATED` de la machine à états
du coffre n'a donc pas lieu d'être — voir D20.

**Ce n'est pas un appel de contrat.** ❌ Réponse la plus structurante, et contraire à ce
que l'interface `IFxVenue` supposait : « The StableFX API handles both offchain and
onchain steps, so you don't need to interact with smart contracts directly. » Le flux est
en trois temps — demande de cotation à plusieurs teneurs, acceptation **hors chaîne** pour
la vitesse, puis règlement par escrow sur Arc avec **Permit2** et confirmation d'intention
en données typées. Voir D21.

**Accès.** ❌ Clé d'API obtenue auprès d'un représentant Circle (sales@circle.com) ;
plateforme « permissioned for vetted financial institutions ». Inaccessible à l'échelle
d'un hackathon.

**Testnet Arc.** ✅ Testnet public depuis novembre 2025, avec RPC, faucet, explorateur et
documentation. Paires USDC/EURC. La décision D8 — construire contre `MockFxVenue` — était
donc la bonne, pour une raison plus forte que prévu.

Sources : [StableFX — docs développeurs](https://developers.circle.com/stablefx) ·
[Circle — StableFX](https://www.circle.com/blog/how-to-build-real-time-stablecoin-fx-in-your-app-with-stablefx) ·
[Arc — FX 24/7](https://www.arc.io/blog/how-arc-can-support-247-onchain-fx)

---

## Privy — org wallets

**Quorum m-sur-n natif.** ✅ « Signatures from m-of-n authorization keys are required to
take action using the wallet », les quorums étant définis par une liste de clés
d'autorisation et un seuil. La décision D7 — l'autorité portée par le contrat — reste
justifiée pour la vérifiabilité, et Privy fournit la défense en profondeur exactement
comme l'architecture l'avait prévu.

**Limites de vélocité.** ✅ Le moteur de politiques couvre les plafonds de montant, les
listes blanches de contrats et de destinataires, et des **fenêtres temporelles**.

**Chaînes.** ✅ Toutes les chaînes EVM, chaînes personnalisées incluses. Aucun obstacle
prévisible pour Arc.

Sources : [Wallet policies and controls](https://docs.privy.io/security/wallet-infrastructure/policy-and-controls) ·
[Policy engine](https://privy.io/blog/turning-wallets-programmable-with-privy-policy-engine)

---

## Ce qui reste réellement à demander

Deux questions seulement, et aucune n'est bloquante.

1. **Chainlink** — CRE supporte-t-il **Arc** comme chaîne de destination pour l'écriture
   d'un rapport ? Sinon, quel est le motif recommandé ?
2. **Circle** — le testnet StableFX est-il ouvert à un participant de hackathon, ou la
   clé d'API est-elle réservée aux institutions vérifiées y compris en environnement de
   test ?

Le message correspondant est dans [`JALON-0-MESSAGES.md`](./JALON-0-MESSAGES.md).

---

## Leçon de méthode

Six des huit questions posées comme « bloquantes » avaient une réponse publique, et deux
de ces réponses invalidaient une partie de l'architecture. Le coût de la vérification
était de dix minutes ; le coût de ne pas vérifier aurait été de construire un adaptateur
de contrat pour un produit qui n'expose pas de contrat.

**Lire la documentation avant de rédiger des questions.**
