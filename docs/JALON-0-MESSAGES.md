# Messages à poster

> La version précédente posait huit questions. Après lecture des documentations, six
> avaient une réponse publique — voir [`JALON-0.md`](./JALON-0.md). Il en reste deux.
>
> Poste-les toi-même : je ne publie rien à l'extérieur.

Une question dont la réponse est dans la documentation ne coûte pas seulement du temps :
elle indique au sponsor qu'on ne l'a pas lue. Ces deux messages montrent l'inverse.

---

## 1 · Chainlink — canal CRE

> Hi! Building **NEAP** for the Confidential Workflow track — an intraday multi-currency
> treasury engine. The risk computation runs on a bank's live FX positions, so it has to
> stay inside the enclave; that confidentiality is what makes the product possible at all.
>
> I've read the Confidential Workflows docs and I'm set up with the local simulator, so
> no blocker on my side. One question I couldn't find an answer to:
>
> **Which destination chains can a CRE workflow write to today — and is Arc (Circle's L1)
> among them?** If not, is the recommended pattern to write on a supported chain and
> bridge, or something else?
>
> Context in case it helps: my handler is a pure function (no I/O, no clock, no
> randomness) that takes encrypted balances plus public market data and emits a signed
> rebalance report. It's already written in TypeScript, so the WASM runtime is a good fit.
>
> Thanks!

---

## 2 · Circle — canal développeurs

> Hi! Building **NEAP** for the Arc DeFi track — an intraday treasury engine that sizes
> multi-currency pre-funding buffers and rebalances through FX. Backtest says the optimal
> buffer drops ~85 % on Arc economics, because a near-zero fixed cost per rebalance makes
> many small orders cheaper than a few large ones under square-root market impact.
>
> I've read the StableFX docs — RFQ off-chain, Permit2-based atomic PvP escrow on Arc,
> API/SDK rather than direct contract calls. I've built against that shape. One question:
>
> **Is the StableFX testnet open to hackathon participants, or is the API key restricted
> to vetted institutions in test environments too?** If it's institutions-only, I'll ship
> against my deterministic mock venue and document the adapter — just want to say the
> right thing rather than imply access I don't have.
>
> Thanks!
