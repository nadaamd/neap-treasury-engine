# Messages à poster — jalon 0

Trois messages courts, prêts à coller dans les canaux Discord des sponsors.
Poste-les toi-même : je ne publie rien à l'extérieur.

Chacun suit la même structure — ce qu'on construit en une ligne, ce qui est déjà fait
(pour qu'on ne nous prenne pas pour des touristes), puis des questions fermées. Une
question fermée obtient une réponse ; une question ouverte obtient un lien vers la doc.

---

## 1 · Chainlink — canal CRE / support

> Hi! Building **FLOAT**, an intraday multi-currency treasury engine for the
> Confidential Workflow track. A bank's FX positions and liquidity buffers can't be
> published in the clear, so the risk computation has to run inside a TEE handler — the
> confidentiality is what makes the product commercially possible, not a nice-to-have.
>
> The risk engine is already written as a pure function (no I/O, no clock, no randomness)
> so it can drop into a handler as-is. Four questions before I wire it up:
>
> 1. Are **CRE TEE handlers** open on public testnet without an allowlist? Any quotas?
> 2. What runtime do handlers use, and are there constraints on maths libraries? My
>    workload is small — a 3×3 covariance, an EWMA, a quantile over ~1 000 samples.
> 3. Is **Arc** (Circle's L1) supported as a destination chain for a CRE workflow? If not,
>    what's the recommended pattern?
> 4. What's the **attestation format**, and can a contract verify it on-chain at
>    reasonable cost? I need the attestation bound to a payload hash so it can't be
>    replayed against a different report.
>
> Thanks!

---

## 2 · Circle / Arc — canal développeurs

> Hi! Building **FLOAT** for the Arc DeFi track — an intraday treasury engine that sizes
> multi-currency pre-funding buffers and rebalances via PvP. The whole thesis rests on
> Arc's economics: with a fixed rebalancing cost near zero, the optimal buffer collapses
> by ~85 % in our backtest, because you can run many small orders instead of a few large
> ones.
>
> Contracts and the off-chain engine are written and tested; I'm plugging in the venue
> adapter now. Four questions:
>
> 1. Is the native **FX RFQ engine** callable by a developer contract on testnet, or is it
>    whitelisted to market makers?
> 2. Is **PvP settlement atomic from the calling contract's point of view** — debit and
>    credit succeed or fail together? This decides whether my vault needs a compensation
>    state.
> 3. Is there EURC/USDC **liquidity on testnet**, and a faucet?
> 4. Is there a **public mempool**? I want to know whether an announced rebalance is
>    front-runnable before I decide how much to reveal on-chain.
>
> Thanks!

---

## 3 · Privy — canal support

> Hi! Building **FLOAT** for the B2B Financial Product track — a treasury engine where a
> risk officer sets limits and a treasurer approves movements above a threshold. Three
> questions about org wallets:
>
> 1. Do org wallets support an **arbitrary EVM chain by chain ID**? I'm targeting Arc
>    (Circle's L1), which is very new.
> 2. Is **m-of-n quorum** native, or are policies single-signer? Not a blocker — I enforce
>    role separation on-chain — but I'd rather not duplicate the authorisation model.
> 3. Do policies support **velocity limits over a rolling window**, or only per-transaction
>    caps?
>
> Thanks!

---

## Ce que change chaque réponse

| Réponse | Conséquence |
|---|---|
| CRE TEE inaccessible | on livre le runner local avec attestation simulée, documenté — le prix Chainlink devient improbable |
| CRE ne cible pas Arc | il faut un relais, ou déplacer la vérification sur la chaîne que CRE sert |
| RFQ Arc fermé | `MockFxVenue` reste le lieu de la démonstration, `ArcFxVenue` devient la preuve d'intégration |
| PvP non atomique | la machine à états du coffre gagne un état `COMPENSATED` |
| Privy sans chain ID libre | Privy pilote la signature, l'exécution passe par une autre chaîne |
| Privy sans quorum natif | rien à faire : l'autorité est déjà portée par le contrat (D7) |
