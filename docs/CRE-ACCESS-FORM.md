# Formulaire d'accès — Confidential Workflows (bêta privée)

<https://docs.google.com/forms/d/e/1FAIpQLSdk8mxDZAXpEX1PHgjzCoBeKxSoQysoO9sxOb-gpBrDrjOhtA/viewform>

Ce que l'approbation ouvre : **90 jours d'accès testnet**, avec capacités de lecture,
d'écriture et de déclenchement sur chaîne, extensibles ou révocables à la discrétion de
Chainlink.

Ce qu'elle ne conditionne pas : le **simulateur local**, qui reste utilisable sans
inscription et suffit à satisfaire le track ETHGlobal (« successful simulation **or**
deployment proof »). Le formulaire est donc un bonus, pas un prérequis — mais un
déploiement testnet réel serait une preuve nettement plus forte qu'une simulation, et
soumettre ne coûte rien.

## Prérequis

Un **CRE organization ID**, à créer sur <https://cre.chain.link> avant de remplir le
formulaire. C'est le seul champ qu'on ne peut pas préparer à l'avance.

## Champs

| Champ | Statut |
|---|---|
| Adresse e-mail | à toi |
| Full Name | à toi |
| Github Username | `nadaamd` |
| Company and Role | à toi — projet personnel, pas un projet XRPL Commons ; à toi de voir ce que tu déclares |
| CRE organization ID | depuis cre.chain.link |
| Use case description | brouillon ci-dessous |
| Additional context | brouillon ci-dessous |
| Acceptation des conditions | à lire toi-même |

## Use case description — brouillon à coller

> FLOAT is an intraday multi-currency treasury engine for institutions that promise
> instant cross-border payments. Such an institution must pre-fund every currency in
> every corridor; that capital sits idle and carries unhedged FX exposure. FLOAT replaces
> static pre-funding with a stochastic control policy: it forecasts net flows per
> corridor, solves optimal rebalancing bands per currency, and triggers a PvP FX
> rebalance only when the marginal benefit exceeds the marginal execution cost.
>
> The confidential handler computes that decision. The inputs that must remain
> confidential are the institution's live balances per currency, its known upcoming
> commitments, and its internal risk limits. Published together, those reveal a complete
> map of the institution's liquidity position — enough for a counterparty to position
> against it. Public inputs (FX rates, gas, indicative quotes) stay outside the enclave.
>
> The handler is a pure function: no I/O, no clock, no randomness. It emits a signed
> report carrying an order commitment plus aggregate risk metrics expressed in basis
> points rather than amounts, so the composition of the plan is never revealed on-chain.
> An on-chain vault verifies the report and then applies its own independent sanity
> bounds before executing anything.
>
> Settlement target is Arc. Written in TypeScript against @chainlink/cre-sdk.

## Additional context — brouillon à coller

> Built for ETHOnline 2026, Confidential Workflow track. The off-chain engine and the
> on-chain contracts are already written and tested — 124 TypeScript tests, 86 Solidity —
> and the decision function is already a pure function, so it should port into a TEE
> handler unchanged. Starting with the local simulator; testnet access would let me show
> a real deployment rather than a simulation.
>
> One question I couldn't answer from the docs: which destination chains can a CRE
> workflow write to today, and is Arc among them?

## Note

Le formulaire précise « please do not include confidential, proprietary, or personal
information ». Les deux brouillons ci-dessus n'en contiennent aucune : ils décrivent une
architecture, pas des données.
