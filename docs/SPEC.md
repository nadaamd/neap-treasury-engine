# NEAP — Intraday Multi-Currency Treasury Engine
### Technical specification — ETHOnline 2026
> Sections marked ⚠️ record open questions and the reasoning that settled them.
> The decisions actually taken are consolidated in [`DECISIONS.md`](./DECISIONS.md).

---

## 0. Metadata

### 0.1 Executive summary

An institution that promises instant cross-border payments must pre-fund every currency of
every corridor. That capital is idle, unremunerated, and carries an unhedged FX exposure. NEAP
replaces static pre-funding with a stochastic control engine: it forecasts net flow per corridor,
computes the optimal rebalancing bands per currency, and triggers a PvP execution on Arc's FX
engine only when the marginal gain (capital released + VaR reduction) exceeds the marginal cost
of execution.

The risk computation runs inside a Chainlink CRE confidential handler (TEE), because no
institution will publish its treasury positions in the clear on a public chain. Operational
governance (roles, limits, separation of duties) rests on Privy org wallets.

### 0.2 Name

**NEAP.** A neap tide is the tide of smallest range: the moment when the swing between high and
low water is at its least. That is exactly what the engine does to a treasury buffer.

The previous name, FLOAT, did designate the capital tied up in transit — the exact industry
term. It was dropped for two reasons. First a collision: Float Financial is a Canadian fintech
with $70M in funding doing corporate cards, expense management and FX, which is the same
neighbourhood. Second because a plain English dictionary word is neither searchable nor ownable,
and it carries a parasitic meaning for a developer audience.

NEAP asks for a step of metaphor most readers will not take on their own. The subtitle must
therefore stay strictly literal — *intraday multi-currency treasury engine* — and never try to be
poetic in turn.

### 0.3 Sponsors and track mapping

| Sponsor | Target track | Prize | What must be demonstrated |
|---|---|---|---|
| Chainlink | Best Confidential Workflow (CRE TEE handlers) | $2,000 | **substantive** TEE integration + proof of simulation/deployment |
| Privy | Best B2B Financial Product | $2,500 | org wallets, working workflow, demo + source |
| Arc (Circle) | Best DeFi / Onchain Finance | $3,500 | working MVP, architecture diagram, video demo |

Total accessible: $8,000. **The criterion is not the prize money but irreducibility**: remove
Chainlink and the positions are exposed, remove Arc and Herstatt settlement risk comes back,
remove Privy and four-eyes control disappears. None of the three is decorative.

---

## 1. Problem and scope

### 1.1 The business problem, precisely

Take an e-money issuer operating N corridors. To honour a EUR → USD payment in under 10 seconds,
it must hold a USD balance **before** receiving the EUR. Three costs follow:

1. **Carry cost** — the pre-funded balance earns nothing (the risk-free rate at best), while the
   institution's cost of capital is higher.
2. **FX risk** — the long USD / short EUR position is a directional position nobody chose,
   nobody wanted, and nobody hedged.
3. **Breach cost** — if the balance runs out, the payment fails or requires emergency funding at
   a punitive price. This cost is strongly asymmetric, and it is what justifies holding a buffer.

The trade-off is a classic stochastic control problem, poorly solved in practice, because bank
treasuries rebalance on a calendar (end of day) rather than on a signal, and on rails
(correspondent banking) whose fixed cost is so high that intraday rebalancing is economically
impossible.

### 1.2 What a rail with sub-second finality and deterministic gas changes

This is the thesis of the project, and it should be stated to judges exactly as it stands:

> The fixed cost of a rebalance on Arc is a few cents in USDC, with finality around 350 ms. In
> the Miller-Orr model, the optimal band width grows as γ^(1/3) where γ is that fixed cost.
> Dividing γ by 10,000 shrinks the band by a factor of ~21.
> **The optimal treasury buffer collapses.** The project quantifies that collapse.

That is a result, not an opinion, and it is demonstrable by backtest. It is the core of the pitch.

### 1.3 v1 scope (hackathon)

**In scope:**
- 4 currencies: USD, EUR, GBP, plus one simulated "exotic" currency (see §1.4).
- A single tenant (one institution), multi-user with roles.
- Flow forecasting, band computation, VaR/ES computation, decision, execution, audit log.
- A reproducible historical backtest + one live execution in the demo.

**Explicitly out of scope:**
- Multi-tenant / netting between institutions (that is a different project).
- Fiat on/off ramps. We reason in stablecoins end to end.
- IFRS 9 hedge accounting, regulatory reporting.
- Optimising the payment routing itself.

### 1.4 ⚠️ Scope question 1: stablecoins ≠ currencies

Arc settles in stablecoins. But the corridors that hurt a neobank are those where **no stablecoin
exists** (PHP, NGN, INR, BRL). Three possible stances:

| Stance | Description | Risk |
|---|---|---|
| **A — Honest and restricted** | Handle only USD/EUR/GBP, where USDC/EURC/GBPx exist. Say that this is the scope where the thesis applies today. | A judge will say "so it does not solve the real problem" |
| **B — Hybrid** | Model 3 real currencies + 1 synthetic leg representing a corridor with no stablecoin, settled off-chain, whose fixed cost stays high. The engine arbitrates between the two regimes. | More complexity, one part mocked |
| **C — Ambitious** | Everything is a stablecoin; assume an EMT exists for every currency. | Hardly credible in front of a Circle judge |

**Chosen: B.** It is the only stance that makes the model *interesting* — because it creates a
genuine trade-off between a low-fixed-cost rail and a high-fixed-cost one, which is exactly the
situation of a treasury in transition. And it is intellectually honest.

### 1.5 ⚠️ Scope question 2: EURC/EUR basis risk

Hedging a EUR exposure with EURC does not hedge perfectly: **basis risk** remains between EURC
and central-bank euro (de-peg risk, issuer risk, redemption liquidity risk). That risk is not in
the classic VaR model and it is structurally invisible in short historical data (the peg holds…
until it does not — see USDC in March 2023).

**Treatment:** an explicit add-on to required capital,
`basis_add_on = h_depeg × exposure`, with `h_depeg` a configurable haircut (default 50 bps).
Naming it and parameterising it, rather than pretending it does not exist, is a strong maturity
signal. **No hackathon project will mention stablecoin/fiat basis risk.**

---
## 2. Actors and journeys

### 2.1 Roles

| Role | Can | Cannot |
|---|---|---|
| **Risk Officer** | set the limits, the haircuts, the risk aversion κ, the per-currency caps | trigger an execution |
| **Treasurer** | approve/reject a rebalancing proposal, execute within the limits | change the limits |
| **Operator (agent)** | execute automatically below the auto-approval threshold | exceed the threshold, change anything |
| **Auditor** | read everything, export the log | write |

**Separation of duties** between Risk Officer and Treasurer is not cosmetic: it is requirement
number one of any bank internal-control framework, and it is what justifies using Privy org
wallets rather than a single key.

### 2.2 Main journey — one decision cycle ("epoch")

```
 t+0ms    Trigger (15-minute cron, or a threshold crossing, or a large incoming flow)
 t+50ms   Collection: balances per currency, pending commitments, FX rates (Data Streams), gas
 t+100ms  Sensitive data encrypted → submitted to the CRE workflow
 t+~2s    The TEE handler: forecasts flows, computes Σ, VaR/ES, solves the bands,
          evaluates the objective, produces an order plan OR a no-op
 t+~3s    The signed and attested report is published on-chain (ReportVerifier)
 t+~3s    If the amount is below the auto-approval threshold → automatic execution
          Otherwise → notify the Treasurer, wait for Privy approval
 t+~4s    The vault requests an RFQ quote, checks deviation against the oracle, executes the PvP
 t+~4.4s  Finality. On-chain log. State updated.
```

### 2.3 Crisis journey (to be demonstrated)

An unexpected large outflow empties a corridor. The lower threshold is crossed, the event-driven
trigger fires off-cycle, the band is recomputed with the recent volatility (which has risen), and
an emergency rebalance is proposed — above the auto-approval threshold, so it requires human
approval. **This is the journey to film**: it shows the system under stress and the governance
holding.

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│  PRESENTATION LAYER                                                      │
│  Dashboard — balances, bands, VaR, history, backtest, approvals.         │
│  Auth via Privy (roles).                                                 │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
┌────────────────────────────────┴────────────────────────────────────────┐
│  ORCHESTRATION LAYER (off-chain, TypeScript service)                     │
│  • Flow ingestion (synthetic generator / replay)                         │
│  • Offline calibration (σ, Σ, seasonality, impact η) — OUTSIDE THE TEE   │
│  • Input encryption, CRE workflow triggering                             │
│  • Backtester (replays N days, compares policies)                        │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
┌────────────────────────────────┴────────────────────────────────────────┐
│  RISK ENGINE — Chainlink CRE, confidential handler (TEE)                 │
│  in  : encrypted balances, encrypted commitments, encrypted limits       │
│  in  : FX rates (Data Streams, public), gas, indicative quotes (public)  │
│  out : signed RebalanceReport + attestation                              │
│  Body: forecast → Σ → VaR/ES → bands → objective function → plan         │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
┌────────────────────────────────┴────────────────────────────────────────┐
│  ON-CHAIN LAYER — Arc                                                    │
│  TreasuryPolicy   limits, bands, roles, thresholds, timelock             │
│  ReportVerifier   checks signature/attestation, nonce, freshness, bounds │
│  RebalanceVault   holds the operational balances, executes, logs         │
│  IFxVenue         Arc RFQ adapter | mock adapter                         │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
┌────────────────────────────────┴────────────────────────────────────────┐
│  CUSTODY & GOVERNANCE — Privy org wallets                                │
│  Roles, policies, velocity limits, approvals, audit trail                │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.1 ⚠️ Architecture question: where does the on-chain / off-chain boundary fall?

This is **the** trap of the project. A quantitative engine is naturally off-chain; if the smart
contract reduces to an `emit Rebalanced(...)`, judges will see it immediately and the project
will be filed under "dashboard with a decorative contract".

The contract must carry four non-trivial things, and that must be defensible:

1. **The policy is the authority** — bands and limits live on-chain, versioned, with a timelock
   on changes. The off-chain engine cannot authorise itself.
2. **Report verification** — DON signature, TEE attestation, replay-protection nonce, freshness,
   and sanity bounds independent of the report itself.
3. **Atomic execution** — the PvP and the state update in one transaction.
4. **A binding audit log** — the audit trail is the product, not a by-product. A treasury needs to
   prove *why* a decision was taken, and with which parameters.

Defensible pitch phrasing: *"the contract does not run the model, it constrains the model"*.

---

## 4. Quantitative model

### 4.1 The guiding principle: one single objective function

⚠️ **Quantitative question 1 — and the subtlest one.** The initial concept had two decision
rules: the Miller-Orr band, and the rule "execute if ΔVaR × cost of capital > execution cost".
Those two rules **can contradict each other**: the band says "do nothing", the VaR rule says
"hedge". Which one wins?

The design answer: **there is only one rule**. The band is not an input of the system, it is the
*result* of a minimisation. Define a total cost per period:

```
J = E[ Σ_t ( r·B_t            carry cost of the balance
            + γ·1{rebal_t}     fixed cost of a rebalance
            + s·Q_t            variable cost (spread + impact)
            + κ·VaR_t          cost of FX risk
            + c_b·1{B_t<L} ) ] breach cost
```

and look for the policy that minimises J. Under strong assumptions (driftless Brownian flows, no
FX risk), the closed-form solution **is** Miller-Orr. When the assumptions are relaxed, it is
solved numerically. Miller-Orr therefore becomes the *verifiable special case* that validates the
implementation, not the final model.

**This reasoning belongs in the pitch.** It shows you know why you use a model, and where it
stops being valid.

### 4.2 Net flow forecasting

Model: compound Poisson process with seasonal intensity.
```
Arrivals:  N_t ~ Poisson( λ_c · s_hour(t) · s_dow(t) )
Amounts:   X_i ~ LogNormal(μ_c, σ_c)   (fat tail, realistic for payments)
Net flow:  F_t = Σ inbound − Σ outbound
Forecast:  F̂_{t+1} = α·F_t + (1−α)·F̂_t, seasonality-adjusted
```

⚠️ **Problem: flows have a drift.** A corridor is structurally unbalanced (EUR → PHP: the flows go
one way). Miller-Orr assumes zero drift and produces symmetric bands, which is wrong here. Two
options:

- **Option 1** — Miller-Orr with drift (asymmetric bands, Constantinides' formula). Rigorous, but
  the formula is heavy and hard to read in a demo.
- **Option 2** — numerical solving: simulate 200 flow paths, search for (L, Z, H) by direct
  optimisation on J. Slower, more general, and **more demonstrable** (you can show the cost
  surface and the minimum).

Chosen: **Option 2**, with analytic Miller-Orr as a regression test on the zero-drift case. It is
also what makes it possible to integrate the VaR term cleanly, which the closed form cannot
absorb.

### 4.3 Volatility and covariance matrix

```
EWMA σ (RiskMetrics):  σ²_t = λ·σ²_{t−1} + (1−λ)·r²_{t−1},  λ = 0.94
Covariance:            Σ̂ = δ·F + (1−δ)·S   (Ledoit-Wolf shrinkage)
```

⚠️ **Problem: the risk horizon is not "one day".** On a 24/7 rail with 350 ms finality, the
relevant horizon is the time during which the position is *held*, that is:

```
h = time until the next decision epoch + execution latency + margin
```

With a 15-minute epoch, h ≈ 16 minutes, not 24 hours. VaR falls by a factor of √96. **This is one
of the most compelling results of the project**: the decision frequency is itself a lever on
required capital, and the capital(frequency) curve can be plotted.

⚠️ **Problem: √t scaling breaks over the weekend.** Stablecoins trade 24/7, fiat does not. The
Monday-morning gap is not modelled by a square root of time. Treatment: an empirical scaling
factor `w_weekend` calibrated on the history of close/open gaps, applied to windows that cross a
weekend. To be parameterised, not ignored.

⚠️ **Problem: correlations break in a crisis.** Ledoit-Wolf shrinkage stabilises the estimate but
does not protect against a regime change. Minimal mitigation: a "correlations → 1" stress scenario
in the backtest, displayed next to the central case.

### 4.4 Risk measures

```
Parametric VaR (display):     VaR_α = z_α · √(w'Σw) · √h
Normal ES (decision):         ES_α = σ · φ(z_α)/(1−α) · √h
Stablecoin basis add-on:      A_basis = h_depeg · |exposure|
Risk capital:                 RC = ES_97.5 + A_basis
```

⚠️ **Problem: parametric VaR assumes normality.** FX returns have fat tails and VaR is not
sub-additive (it can penalise diversification). Decision: **VaR for display** (because it is the
language of the business), **ES for the decision** (because it is coherent and sensitive to the
tail). If time permits: Filtered Historical Simulation (resampled standardised residuals) as a
third estimator, to show the gap between the three — a comparison table normal-VaR / ES / FHS is
an excellent competence signal.

### 4.5 Hedging

```
Minimum-variance hedge ratio:  h* = ρ · σ_spot / σ_hedge
```

⚠️ **Problem: do not over-hedge.** Hedging EUR/USD mechanically reduces GBP/USD exposure through
correlation. The computation must be done **at portfolio level**, not currency by currency, or the
same risk is paid for twice. It is a classic trap, and showing it ("naive per-currency hedge:
X bps; portfolio hedge: 0.6X bps") is a strong point.

### 4.6 Execution cost

```
Total cost of an order of size Q:
   C(Q) = s_rfq·Q + gas_usdc + η·Q^(3/2)   (temporary impact, classic form)
```

⚠️ **Major problem: η is not calibratable.** Arc has been on mainnet for a few days; the depth of
the RFQ book is unknown and probably thin. Treatment:
- expose η as a visible parameter in the UI,
- display the sensitivity of the result to η (sensitivity analysis over 3 values),
- **never** present a gain figure without stating the impact assumption.

A Circle judge knows the real depth of their own book. Claiming to have calibrated it would be
detected immediately. Owning the uncertainty is the right strategy.

### 4.7 Exposed parameters

| Parameter | Symbol | Default | Source / justification |
|---|---|---|---|
| Cost of capital | r | 6%/year | institutional assumption; open to discussion |
| Risk aversion | κ | 0.10 | calibrated so the risk term is ~20% of J |
| Breach cost | c_b | absolute, $50,000 | strong asymmetry; it is what creates the buffer (see D14) |
| EWMA decay | λ | 0.94 | RiskMetrics standard |
| De-peg haircut | h_depeg | 50 bps | judgement; no reliable data |
| Impact | η | to be displayed | not calibratable (§4.6) |
| Epoch period | Δt | 15 min | compute cost vs responsiveness (see D12) |
| Auto-approval threshold | — | 100k USDC | policy, on-chain |

⚠️ **Every default above is a judgement, not a measurement.** The spec must own that, and the UI
must let the parameters be changed live during the demo — which is more convincing than a figure
presented as a truth.

---

## 5. Data

### 5.1 ⚠️ Founding problem: no real data is accessible

Nobody publishes a neobank's payment flows per corridor. That is the structural constraint of the
project and it must be addressed head-on, not worked around.

| Option | Description | Verdict |
|---|---|---|
| A — Synthetic generator | compound Poisson calibrated on public aggregates | ✅ chosen |
| B — Public proxy | ECB SEPA statistics, World Bank remittance corridors | ✅ chosen **to calibrate A** |
| C — Replay of on-chain USDC flows | real transfers observed on Ethereum/Base | ⚠️ interesting, but these are not customer payment flows |
| D — Claim real data | — | ❌ disqualifying |

**Chosen strategy: A calibrated on B, with a deterministic seed.** The generator is a delivered,
documented component, with its calibration parameters and their sources. Reproducibility (same
seed → same results) is a requirement: a non-reproducible backtest has no evidential value, and a
judge may ask to replay it.

Plus a sanity test: the statistical properties of the generated flow (mean, variance,
autocorrelation, weekly seasonality) must match the public aggregates to within ±X%. That test is
what makes the generator defensible.

### 5.2 Market data

| Data | Live source | Historical source | Problem |
|---|---|---|---|
| EUR/USD, GBP/USD | Chainlink Data Streams | ECB series | ⚠️ **source mismatch**: σ is calibrated on daily ECB data, then applied to a high-frequency Data Streams feed. The two do not measure the same thing. To be documented, and where possible corrected by a measured scaling factor. |
| EURC/USDC price | Arc RFQ quote | none | no history → the basis σ cannot be estimated → hence the flat haircut in §1.5 |
| USDC gas | Arc RPC | — | must be estimated **before** deciding, not after |

⚠️ **Problem: data freshness is a security assumption.** If the FX rate used to decide is 3
minutes stale and the market has moved, the decision is bad and the execution can be arbitraged.
The contract must reject any report whose inputs exceed a staleness threshold, and the engine must
bound the allowed deviation between the decision price and the execution price.

---

## 6. The Chainlink CRE confidential workflow
### 6.1 Why the TEE is necessary (the argument not to miss)

Without confidentiality, the project is an academic demonstration. An institution that published
its balances per currency, its upcoming commitments and its internal limits would hand its
counterparties a complete map of its liquidity position — that is, enough to trade against it.
**The TEE is not a technical bonus, it is the condition under which the product can exist
commercially.** That is the sentence to say to the Chainlink judge.

### 6.2 Splitting computation from confidentiality

⚠️ **Problem: what actually goes inside the TEE?** A TEE has resource and time constraints. A
90-day backtest has no place in one. Proposed split:

| Stage | Where | Why |
|---|---|---|
| Calibration (σ, Σ, seasonality, η) | **outside the TEE**, offline | heavy, and the aggregated parameters are barely sensitive |
| Band solving by simulation | **outside the TEE** if too heavy, otherwise inside | ⚠️ a load decision to be measured |
| Per-epoch decision (VaR, objective, plan) | **inside the TEE** | this is where the positions live |
| Backtest | outside the TEE, entirely | an analysis tool, not production |

⚠️ If band solving moves outside the TEE, it must do so **without seeing the balances** — it takes
only statistical parameters (σ, λ, costs). That is feasible and in fact clean: the band is a
function of the parameters, not of the state. The reasoning needs checking.

### 6.3 Handler interface

```
Encrypted input : balances[currency], commitments[currency][horizon], limits, policyVersion
Public input    : fxRates (Data Streams), gasPrice, indicativeQuotes, epoch, nonce
Output (report) : { epoch, nonce, expiry, policyVersion, orders[], varBefore, varAfter,
                    costEstimate, inputsHash, attestation }
```

### 6.4 ⚠️ Major problem: information leakage through the outputs

Encrypting the inputs is pointless if the output reveals the input. Publishing
`orders = [{EUR→USD, 3,214,500}]` reveals a large part of the position. An observer tracking
reports across several epochs can reconstruct the flows by difference.

Mitigation options, in increasing order of cost:

| Option | Effect | Cost |
|---|---|---|
| Quantisation (round to 100k) | reduces precision, not the trend | none |
| Calibrated noise (differential privacy) | statistically protective | degrades the decision |
| Random temporal batching | breaks the time correlation | adds latency, hence risk |
| On-chain commitment + execution via Arc confidential transfers | genuinely protects the amount | high complexity, depends on Arc |
| Publish only the hash + a proof of compliance with the bounds | strong protection | the bounds must be proven without revealing |

**v1 choice: quantisation + commitment.** We publish `hash(orders)`, the verified bounds, and the
aggregated metrics (ΔVaR in %, not as an amount). The exact amount travels only to the venue.
**But it must be stated explicitly**: v1 still leaks information through the on-chain observable
transaction size, unless Arc's confidential transfers are usable. Saying so is stronger than
hiding it.

### 6.5 ⚠️ Open CRE questions (blocking risk 1)

To check **before writing a line of code**:
- Are CRE TEE handlers reachable on public testnet without an allowlist? Quotas?
- Which language / runtime for the handler? Which maths libraries are available? (with no linear
  algebra library, computing `w'Σw` over 4 currencies is still feasible by hand — but you need to
  know)
- What is the attestation format, and can a contract verify it on-chain economically?
- How are secrets provided to the handler (decryption key)? Who holds them?
- Maximum execution time, maximum input size?
- Does CRE run *on* Arc, or is a bridge to Arc required? ⚠️ **If CRE does not support Arc as a
  destination chain, the whole architecture has to be revisited.** That is question number one for
  Chainlink support as soon as the hackathon opens.

**Plan B if CRE-TEE is unreachable:** implement the handler as an isolated service with a
simulated attestation and an identical interface, documenting the mock honestly. But the track
requires a "meaningful TEE integration" with proof of simulation or deployment — a full mock would
probably lose the Chainlink prize. **Decide early.**

---

## 7. Arc integration

### 7.1 What we use

| Arc capability | Use in NEAP | Criticality |
|---|---|---|
| Gas in USDC | makes the fixed cost γ deterministic in dollars — a direct term of the objective | **essential** |
| ~350 ms finality | shortens the risk horizon h, hence VaR, hence the buffer | **essential to the thesis** |
| Native FX engine (RFQ + PvP) | executes the rebalancing legs with no settlement risk | **essential** |
| Confidential transfers | masks the size of the orders (§6.4) | desirable |

### 7.2 ⚠️ Arc questions (blocking risk 2)

- **Mainnet launches on 16 September 2026.** Documentation, SDK, testnet faucet, RPC stability:
  everything is new. Budget far more integration time than for a mature EVM chain.
- **Is the RFQ open to developers, or reserved to whitelisted market makers?** It is very likely
  an institutional system with onboarding. If so, the core of the project is not accessible. →
  **Mandatory mitigation from the start: the `IFxVenue` interface with two implementations,
  `ArcFxVenue` and `MockFxVenue`.** The engine must never depend on Arc directly. That is good
  design anyway, and it saves the project if access is missing.
- **Real EURC/USDC liquidity**: if the book is empty on testnet, no realistic execution is
  possible → the mock becomes the main demonstration path, and the Arc deployment becomes the
  integration proof.
- **Confidential transfers**: which primitives exactly? Callable from a contract? Gas overhead?
  Interoperable with the RFQ? Probably not all at once.
- **MEV / mempool**: Arc is a Tendermint-style BFT chain. Is there a public mempool? A rebalance
  announced before execution is front-runnable. ⚠️ To investigate: this is a real financial risk,
  not a theoretical question.
- **Finality vs economic security**: 350 ms BFT finality with 11 institutional validators — the
  trust model differs from a permissionless chain. To be stated honestly in the "trust
  assumptions" section.

---

## 8. Governance and custody — Privy

### 8.1 What we build

- One org wallet per entity, with the 4 roles from §2.1.
- Policies: per-transaction cap, rolling-window cap (velocity limit), destination allowlist,
  per-currency restriction.
- Approval flow: above the threshold, the Treasurer approves explicitly.
- Approval log exported into the on-chain audit trail.

### 8.2 ⚠️ Privy questions

- **Does Privy support native m-of-n quorum, or only single-signer policies?** Without quorum it
  has to be carried at contract level (multisig), which creates a redundant authorisation model
  between Privy and the chain. → clarify early who is the authority.
- **Is separation of duties actually enforceable?** Preventing a Risk Officer from triggering an
  execution assumes the roles are held by distinct keys AND that the contract distinguishes them.
  A control that only exists in the UI is not a control.
- **Honest trust assumption**: a Privy org wallet is delegated custody. A bank would not put its
  entire treasury behind one. Positioning to own: **a capped operational wallet**, with the bulk of
  the treasury in cold custody. Saying so strengthens credibility.
- **Does Privy support Arc as a chain?** ⚠️ Blocking question 3. A chain launched days ago is
  probably not in the default list. Check support for arbitrary EVM chains by chain ID.

---

## 9. Contracts

### 9.1 Inventory

| Contract | Responsibility | Complexity |
|---|---|---|
| `TreasuryPolicy` | limits, thresholds, roles, versioning, timelock on changes | medium |
| `ReportVerifier` | checks the DON signature + TEE attestation, nonce, expiry, inputsHash | **high** |
| `RebalanceVault` | holds the operational balances, executes the plan, logs | medium |
| `IFxVenue` | `ArcFxVenue` \| `MockFxVenue`; deviation check | medium |
| Circuit breaker | pause, sanity caps independent of the report | low |

### 9.2 Order state machine

```
PROPOSED ──verify──> VERIFIED ──approve──> APPROVED ──quote──> QUOTED
                         │                     │                  │
                      REJECTED              EXPIRED          ──execute──> SETTLED
                                                                  │
                                                                FAILED
```

> The `COMPENSATED` state was removed once StableFX's PvP was documented as atomic — see D20.

### 9.3 ⚠️ Contract questions

- **Idempotency.** A replayed order = a double rebalance = a doubled position. A mandatory
  idempotency key: `keccak(policyVersion, epoch, nonce, ordersHash)`, consumed atomically. It is
  the most expensive bug possible in this domain.
- **Atomicity of the FX leg.** If the swap succeeds but the accounting fails, state would diverge.
  Is Arc's PvP atomic from the calling contract's point of view? If not, a state machine with
  explicit compensation (a `COMPENSATED` state).
- **Deviation check.** The contract compares the RFQ price obtained against the oracle price and
  rejects beyond a threshold (e.g. 30 bps). Without it, a malicious venue or an empty book
  executes at the worst price. **This is the system's most important protection.**
- **Staleness.** Reject any report whose `expiry < block.timestamp` or whose FX inputs exceed the
  maximum age.
- **Independent sanity bounds.** The contract does not trust the report: a hard cap as a % of the
  treasury per epoch, an absolute cap, a rolling 24h cap. If the model goes wrong (calibration bug,
  division by a zero volatility), the contract contains the damage.
- **Kill switch** held by a distinct role, with no timelock (emergencies cannot be scheduled).
- No upgradeable proxy in v1 — needless complexity and attack surface for a hackathon; a kill
  switch plus redeployment is enough.
- Re-entrancy on venue calls → `nonReentrant` + checks-effects-interactions.

---

## 10. Security and trust model

### 10.1 Assumptions to state explicitly

| We trust | For what | If it is false |
|---|---|---|
| the TEE enclave | confidentiality and integrity of the computation | positions exposed, decisions falsified |
| the Chainlink DON | signing the report | forged reports → the contract's sanity bounds limit the damage |
| FX Data Streams | correct prices | bad decision → the deviation check limits the damage |
| the Arc validators | finality | theoretical double spend |
| Privy | custody of the operational keys | theft capped by the velocity limits |
| the stablecoin issuer | maintaining the peg, not freezing | uncovered loss — this is the basis risk of §1.5 |

This table **is a deliverable**. A judge from finance will assess a project on its ability to state
its trust assumptions, not on the absence of dependencies.

### 10.2 Specific attack surfaces

- **Oracle manipulation** → deviation bounds, multi-source comparison, staleness rejection.
- **Front-running the rebalance** (§7.2) → depends on Arc's mempool, to be investigated.
- **Leakage through the outputs** (§6.4) → quantisation + commitment.
- **Operator compromise** → velocity limits + a low auto-approval threshold.
- **Griefing by triggering**: an attacker generating micro-flows to force expensive rebalances.
  Mitigation: a minimum cooldown between epochs, the fixed cost built into J (the model already
  refuses unprofitable rebalances — that is a property of the design).
- **Division by zero / zero volatility** in a quiet period → a floor on σ. A classic and
  devastating bug: σ→0 drives the band towards 0 and triggers permanent rebalancing.

---

## 11. Regulatory realism (one slide, not a chapter)

⚠️ These questions will be asked by a judge from the industry. Each needs a one-sentence answer,
not an essay.

- **MiCA** — a EUR stablecoin used in treasury is an EMT; regulated use, authorised issuer
  required. EURC is issued by Circle through a European entity: the answer is available.
- **Safeguarding** — an EMI's client funds must be segregated. Is the pre-funding own funds or
  client funds? **Answer: own funds only in v1**, and that is a limitation to state.
- **Hedge accounting (IFRS 9)** — out of scope, but acknowledge that hedging creates P&L noise if
  it is not documented under hedge accounting.
- **Reporting** — CRE can format in ISO 20022, which allows movements to be emitted into an
  existing back office. That is an excellent closing point: the system does not ask the bank to
  change its plumbing.

---

## 12. Demonstration

### 12.1 ⚠️ Problem: how do you prove a 90-day gain in 3 minutes?

The project's result is statistical, the demo is temporal. Resolved in three beats:

1. **The backtest, precomputed** (20 s) — one chart: idle capital under a static policy vs NEAP,
   over 90 simulated days, with ΔVaR and cumulative execution costs. Three policies compared:
   static, calendar (end of day), NEAP.
2. **The sensitivity** (20 s) — the same chart recomputed live when κ or η is moved in the UI. It
   proves the model is alive and not a hard-coded number.
3. **A live execution** (60 s) — the crisis journey of §2.3: flow shock, threshold crossing, TEE
   computation, a proposal above the threshold, Privy approval by a second role, PvP execution on
   Arc, finality, log.

### 12.2 Metrics to display (and not to inflate)

| Metric | Expected | Trap |
|---|---|---|
| Idle capital | −30 to −45% | depends entirely on γ and c_b — display the assumptions |
| Portfolio VaR | −40 to −60% | comes mostly from the shorter horizon, not from the model — say so |
| Execution costs | +10 to +20% | **must increase**: we rebalance more often. Hiding it would be suspicious. |
| Number of breaches | 0 | at equal constraint, this is the real proof |

**Displaying the increase in execution cost is more convincing than hiding it.** A quantitative
judge looks for the trade-off; a project that shows only improvements has no model.

### 12.3 Honesty about the mocks

A "what is real / what is simulated" section in the README and in the video. The flow data is
synthetic, η is not calibrated, the venue may be mocked. **ETHGlobal judges value that
transparency and penalise its late discovery heavily.**

---

## 13. Delivery plan

### 13.1 Milestone 0 — to be done BEFORE writing code (a few hours)

The three blocking questions, to be asked in the sponsor Discords as soon as they open:

1. **CRE**: are TEE handlers freely accessible, and is Arc a supported destination chain?
2. **Arc**: is the RFQ FX engine callable by a developer contract on testnet, or whitelisted?
3. **Privy**: do org wallets support an arbitrary EVM chain by chain ID, and is m-of-n quorum
   native?

**The answers determine the architecture.** If (1) is no → reposition on another sponsor or own a
documented mock. If (2) is no → `MockFxVenue` becomes the main path. If (3) is no → the quorum
moves into the contract.

### 13.2 Work packages

| Package | Content | Dependencies |
|---|---|---|
| L1 | Flow generator + calibration + backtest harness | none |
| L2 | Quantitative engine (forecast, Σ, VaR/ES, band solving, objective) | L1 |
| L3 | Contracts + tests (policy, verifier, vault, venue, breaker) | none |
| L4 | CRE handler + encryption + attestation verification | L2, L3, milestone 0 |
| L5 | Venue adapters (mock + Arc) | L3, milestone 0 |
| L6 | Privy: roles, policies, approval flow | L3 |
| L7 | Dashboard + backtest visualisation | L1, L2 |
| L8 | Demo, video, README, architecture diagram, feedback | everything |

**Critical path: L2 → L4.** The quantitative engine must be finished and tested before attempting
the port into the TEE, otherwise two problems are being debugged at once in the most constrained
environment.

**Cut rule**: if time runs short, sacrifice in this order — confidential transfers, the 4th
currency, FHS, the crisis journey. **Never** sacrifice the comparative backtest: it is the only
deliverable that proves the thesis.

---

## 14. Decisions taken

Arbitration criterion: **maximise defensible technical density per unit of time**. A decision wins
if (a) it produces an artefact a senior engineer recognises as non-trivial, (b) it remains
deliverable in three days, (c) it removes an external dependency rather than creating one.

> The consolidated, up-to-date list — including the decisions taken during implementation —
> lives in [`DECISIONS.md`](./DECISIONS.md). What follows is the original reasoning.

| # | Decision | Justification |
|---|---|---|
| **D1** | **NEAP** — *Intraday Treasury Engine* | a neap tide is the tide of smallest range; the name states what the engine does to a buffer. Readable by a treasurer and by a crypto judge alike. The subtitle stays strictly literal. |
| **D2** | **Hybrid stance**: 3 stablecoin currencies (USD/EUR/GBP) + 1 "slow rail" corridor with no stablecoin (EUR→BRL), modelled with a high fixed cost and T+2 latency | this is the only framing that creates a **trade-off between two cost regimes**. Without it the model has one rail and the optimiser optimises nothing interesting. It is also the real situation of a treasury in transition — hence the portfolio angle. |
| **D3** | **Numerical band solving** (Monte-Carlo + direct search), **warm-started by the analytic Miller-Orr solution**, which also serves as a regression test on the zero-drift case | the warm start makes the search fast *and* demonstrates that we know where the closed form is valid. Two competence signals from one component. |
| **D4** | **ES 97.5% (FRTB-aligned) estimated by Filtered Historical Simulation**, with normal ES as a benchmark and VaR 99% for display | FRTB replaced VaR with ES 97.5% precisely for the reasons in §4.4. Citing the standard and implementing it costs ~30 lines (standardise residuals by the EWMA vol, resample, rescale). **The comparison table of the three estimators is the project's best portfolio artefact.** |
| **D5** | **Confidentiality boundary: the TEE computes only what depends on state.** Everything that depends only on parameters (bands, σ, Σ, η) is computed outside the TEE and **committed on-chain by hash** | a simple rule, stateable in one sentence, and verifiable. The bands are a function of the statistical parameters, not of the balances; the balances never leave the enclave. `bandParamsHash` binds the TEE report to an auditable parameter set. |
| **D6** | **Commitment + quantisation into 100k lots + temporal jitter** on the trigger. Arc confidential transfers as a secondary goal. Residual leakage documented. | real, implementable protection; honestly documenting the residual leakage is worth more than overplayed protection. |
| **D7** | **The contract is the authority.** `TreasuryPolicy` carries the roles, separation of duties and the auto-approval threshold on-chain. Privy provides custody, policies as defence in depth, and UX. | ⚡ **the most structuring decision.** It removes the dependency on a possible native Privy quorum, makes the authorisation model *verifiable* rather than contractual, and — critically — gives the smart contract substantial responsibility, which neutralises the §3.1 risk ("decorative contract"). |
| **D8** | `IFxVenue` with **`MockFxVenue` as the reference venue** (configurable, replayable, deterministic book) and `ArcFxVenue` as the real integration | this is not a fallback: the backtest **requires** a deterministic venue. The mock is a necessary deliverable, the Arc adapter is the integration proof. The milestone-0 dependency disappears. |
| **D9** | **The risk engine is a pure function**, with no I/O, compiled once and run either in the CRE handler or in an isolated local runner, with identical inputs and outputs. `ReportVerifier` checks the attestation through an interchangeable `IAttestationVerifier`. | same code, two hosts: the plan B costs nothing because it is the same thing. We attempt the real CRE deployment; if it is unreachable, we ship the simulated attestation and document it. |
| **D10** | **Walk-forward backtest protocol, no lookahead, 20 seeds, with confidence intervals** | ⚡ **the portfolio differentiator.** Calibrating on `[0,t)` and deciding at `t` eliminates lookahead bias; reporting "−37% ± 4%" rather than "−41%" is the gesture that separates an engineer from a demo author. Marginal cost: a few hours. |

### 14.1 What these choices imply, together

Three of them reinforce each other and form the defensible backbone of the project:

- **D7** makes the contract substantial → the project is not "a dashboard with an `emit`".
- **D5** makes confidentiality stateable in one sentence → the Chainlink judge understands it in
  ten seconds.
- **D4 + D10** make the numbers credible → the quantitative judge cannot take them apart.

And two of them **remove the blocking dependencies** identified in §13.1: D8 neutralises the risk
around Arc RFQ access, D9 neutralises the risk of the TEE being unavailable. The milestone-0
questions still need asking, but **no negative answer kills the project any more**. That is the
real gain of this arbitration session.

---

## 15. Data model

### 15.1 Off-chain entities

```
Corridor        { id, base, quote, rail: FAST|SLOW, gammaFixed, latencySec, etaImpact,
                  maxDepth }
FlowEvent       { ts, corridorId, direction: IN|OUT, amount, currency }
Commitment      { id, currency, amount, dueTs, certainty }   // known upcoming commitments
BalanceSnapshot { ts, currency → amount, source: CHAIN|LEDGER }
MarketTick      { ts, pair, mid, source: DATA_STREAM|ECB|RFQ }
BandSet         { paramsHash, currency → { L, Z, H }, solvedAt, method: ANALYTIC|NUMERIC }
EpochDecision   { epoch, inputsHash, bandParamsHash, riskMetrics, plan, commitment,
                  status, txHash }
BacktestRun     { seed, policy, params, metrics, walkForwardWindows }
```

`Commitment.certainty` deserves a word: a scheduled payroll payment is certain, a forecast flow is
probabilistic. The two do not enter the buffer computation in the same way — the first reduces the
available balance, the second only affects the distribution. Conflating them is a classic treasury
engine mistake.

### 15.2 On-chain structures

```solidity
struct CurrencyPolicy {
    uint128 lowerBand;         // L   (native token units, 6 decimals)
    uint128 target;            // Z*
    uint128 upperBand;         // H
    uint128 maxSingleOrder;
    uint128 maxPerEpoch;
    uint128 maxRolling24h;
}

struct RiskParams {
    uint32  kappaBps;              // risk aversion
    uint32  hDepegBps;             // stablecoin basis haircut  (§1.5)
    uint32  maxExecDeviationBps;   // RFQ vs oracle deviation check
    uint32  maxStalenessSec;
    uint32  minEpochIntervalSec;   // anti-griefing cooldown
    uint128 autoApproveThreshold;
}

struct RebalanceReport {
    uint64  epoch;
    uint64  nonce;
    uint64  expiry;
    uint32  policyVersion;
    bytes32 bandParamsHash;    // binds the report to the out-of-TEE parameters (D5)
    bytes32 inputsHash;        // hash of the public inputs: fx, gas, quotes
    bytes32 ordersCommitment;  // keccak(abi.encode(orders, salt))        (D6)
    int32   varBeforeBps;      // aggregated, quantised metrics
    int32   varAfterBps;
    uint128 costEstimate;
    bytes   attestation;
}
```

Design note: the risk metrics are published **in relative basis points**, never as absolute
amounts — a direct consequence of D6, and it shows in the type (`int32`, not `uint256`).

---

## 16. Contract interfaces

### 16.1 `TreasuryPolicy` — the authority (D7)

```solidity
bytes32 constant RISK_OFFICER = keccak256("RISK_OFFICER");
bytes32 constant TREASURER    = keccak256("TREASURER");
bytes32 constant OPERATOR     = keccak256("OPERATOR");
bytes32 constant GUARDIAN     = keccak256("GUARDIAN");

function proposePolicy(address token, CurrencyPolicy calldata p) external;  // RISK_OFFICER
function commitPolicy(uint32 version) external;                             // after the timelock
function setRiskParams(RiskParams calldata r) external;                     // RISK_OFFICER + timelock
function commitBandParams(bytes32 paramsHash) external;                     // RISK_OFFICER  (D5)
function pause() external;                                                  // GUARDIAN, no timelock
```

**Separation-of-duties invariant, enforced on-chain:** no address can hold `RISK_OFFICER` and
`TREASURER` at once. It is a `require` in `_grantRole`, not a UI rule. It is what gives D7 its
meaning and it is **the first unit test to write**.

Timelock: 24 h nominal, reduced to 60 s through a build constant in demo mode — and demo mode is
visible on screen, so that nobody believes the timelock is cosmetic.

### 16.2 `ReportVerifier`

```solidity
function verify(RebalanceReport calldata r, bytes calldata donSig)
    external returns (bytes32 reportId);
```

Checks, in order (cheapest first):
1. `!paused`
2. `r.expiry > block.timestamp` and `r.epoch > lastEpoch + minEpochInterval`
3. `r.policyVersion == currentVersion` and `r.bandParamsHash == committedBandParamsHash`
4. `nonce` not consumed → consumed atomically
5. valid DON signature over `keccak(abi.encode(r))`
6. `IAttestationVerifier.verify(r.attestation, expectedMeasurement)` — interchangeable adapter (D9)

`reportId = keccak256(policyVersion, epoch, nonce, ordersCommitment)` — **the idempotency key**.

### 16.3 `RebalanceVault`

```solidity
function submit(RebalanceReport calldata r, bytes calldata sig) external;    // OPERATOR
function approve(bytes32 reportId) external;                                 // TREASURER
function execute(bytes32 reportId, Order[] calldata orders, bytes32 salt)
    external nonReentrant;                                                   // OPERATOR
```

`execute`:
1. state == `VERIFIED` (≤ threshold) or `APPROVED` (> threshold)
2. `keccak(abi.encode(orders, salt)) == ordersCommitment` — the commitment reveal (D6)
3. **sanity bounds independent of the report**: each order ≤ `maxSingleOrder`, the epoch sum ≤
   `maxPerEpoch`, the rolling 24 h window ≤ `maxRolling24h`
4. for each order: `venue.quote()` → deviation check against the oracle → `venue.settlePvP()`
5. accounting, `emit Rebalanced(...)`, state transition

Point 3 is essential: **the contract never trusts the report**. If the model goes wrong (zero
estimated volatility, division by zero, corrupted calibration), the bounds contain the damage.
That is the difference between a system and a script.

### 16.4 `IFxVenue` (D8)

```solidity
interface IFxVenue {
    function quote(address tokenIn, address tokenOut, uint256 amountIn)
        external view returns (uint256 amountOut, uint64 quoteExpiry, bytes32 quoteId);

    function settlePvP(address tokenIn, address tokenOut, uint256 amountIn,
                       uint256 minAmountOut, address to, bytes32 quoteId)
        external returns (uint256 amountOut);
}
```

`MockFxVenue`: a configurable book (depth, η, spread), deterministic for a given seed — this is
the backtest venue. `ArcFxVenue`: an adapter to the native RFQ.

That the backtest and production share the **same interface** is a design point worth
highlighting: the policy tested is literally the policy executed.

### 16.5 State machine and allowed transitions

```
                submit            approve           execute
   (nothing) ─────────────> VERIFIED ────────> APPROVED ────────> SETTLED
                              │  └──────── execute (if ≤ threshold) ──┘
                              │
                          EXPIRED  (past expiry)
                              │
                           FAILED
```

⚠️ A `COMPENSATED` state would only exist if Arc's PvP were **not** atomic from the caller's point
of view. The documentation confirms it is atomic, so that state was removed (D20).

---

## 17. Flow generator calibration

### 17.1 Structure

```
Arrivals   N_t ~ Poisson( λ_c · s_hour(t) · s_dow(t) · s_dom(t) )
Amounts    X_i ~ LogNormal(μ_c, σ_c)
Net flow   F_t = Σ IN − Σ OUT
```

| Parameter | Initial value | Calibration source | Confidence |
|---|---|---|---|
| `λ_EUR/USD` | ~ corridor daily volume / average size | ECB SEPA statistics | medium |
| `s_hour` | bimodal profile, overnight trough | published retail payment profiles | medium |
| `s_dow` | weekend trough (−60%) | idem | good |
| `s_dom` | peaks on the 1st and at month end (payroll) | idem | good |
| `μ_c, σ_c` | log-normal, fat tail | World Bank remittance corridors | medium |
| per-corridor `drift` | outbound for EUR→BRL | remittance flow structure | good |

### 17.2 Generator validity tests

The generator is only defensible if it is **tested**. The test suite to write:

1. mean and variance of the daily flow within ±10% of the public aggregates;
2. weekly profile: weekend/weekday ratio inside the target range;
3. autocorrelation at lag 1 day and lag 7 days inside the target range;
4. kurtosis of the amounts > 3 (the fat tail must exist, otherwise the VaR is wrong);
5. reproducibility: same seed → identical output hash.

**Test 5 is the one a judge can verify in ten seconds**, and it is what makes all the others
credible.

### 17.3 Costs

| Quantity | FAST rail (Arc) | SLOW rail (correspondent) |
|---|---|---|
| Fixed cost γ | USDC gas, around a cent | transfer fee, tens of dollars |
| Latency | ~350 ms | T+1 to T+2 |
| Spread | RFQ, to be measured | bank spread, wider |
| Impact η | not calibratable (§4.6), exposed as a parameter | not applicable (negotiated price) |

The ratio of the γ between the two rails is of the order of 10³–10⁴. **That ratio is what produces
the buffer collapse announced in §1.2, and it is the only truly structural quantity in the model.**
The whole demo should revolve around it.

---

## 18. Backtest protocol (D10)

### 18.1 Walk-forward, no lookahead

```
For each window w = 1..W:
    calibration (σ, Σ, λ, μ, bands)  over  [t0, t_w)        ← strict past
    policy simulation                over  [t_w, t_{w+1})   ← unseen future
    metric accumulation
```

No parameter used at time `t` may have been estimated with data later than `t`. It is a constraint
simple to state and easy to violate by accident — hence a dedicated test: a lookahead "canary", an
injected series whose extreme future value must have no effect on earlier decisions.

### 18.2 Compared policies

| Policy | Description | Role |
|---|---|---|
| `STATIC` | fixed buffer sized on the worst observed flow | upper control — the current state of the art |
| `CALENDAR` | end-of-day rebalancing, fixed target | realistic control — what a treasury actually does |
| `NEAP` | optimised bands, signal-driven triggering | the subject |
| `CLAIRVOYANT` | the same solver calibrated on the realised window | reference point |

⚡ `CLAIRVOYANT` was designed as an upper bound — the optimal policy given perfect knowledge of
the coming period. The backtest showed it is not one: NEAP beats it four times out of five, by a
percent or two, because the solver is heuristic and the measured criterion is *realised*
out-of-sample cost rather than the one it minimises. The quantity is therefore reported as what it
actually measures — the cost of estimation uncertainty — and a confidence interval containing zero
is a result in itself.

### 18.3 Reported metrics

Over 20 seeds, mean and 95% confidence interval:

| Metric | Meaning |
|---|---|
| average idle capital | the main objective |
| average portfolio ES 97.5% | the risk carried |
| cumulative execution costs | **expected to increase** — that is the trade-off |
| number of threshold breaches | hard constraint: should stay near 0 |
| number of rebalances | activity measure, detects over-trading |
| cost of estimation uncertainty | what calibrating on the past actually costs |

A six-row table with confidence intervals. Nothing visually spectacular, and that is exactly why
it is convincing.
