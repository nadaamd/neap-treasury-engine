# NEAP

### Instant payments need pre-funded cash. NEAP cuts that cash by 84.6%.

**[Open the live demo →](https://neap-git-main-nadas-projects-0f34418c.vercel.app)**  ·  [Dashboard](https://neap-git-main-nadas-projects-0f34418c.vercel.app/app)  ·  [Results](./docs/BACKTEST.md)

Intraday multi-currency treasury engine, built for ETHOnline 2026 on **Arc** · **Chainlink CRE** · **Privy**.

---

## The 30-second version

Promise an instant cross-border payment and you must hold the destination currency
**before** the money arrives. Every corridor, every currency, all day. That cash earns
nothing and carries an FX position nobody chose.

Treasuries size it the way they always have: look at the worst day of last quarter,
provision that much, move on. It works, and it is expensive.

NEAP replaces the heuristic with stochastic control. It forecasts net flow per corridor,
solves the rebalancing bands that minimise one cost function — carry, fixed cost,
execution, FX risk, breach risk — and moves only when the balance leaves the band.

> **The band is not a setting. It is the minimum of the objective.**

Measured over 20 seeds × 6 walk-forward windows: **idle capital −84.6%, FX risk −89.4%,
total cost −24.4%.**

---

## Why this is only possible now

Band width grows as the **cube root of the fixed cost per rebalance**. On correspondent
banking rails that cost is tens of dollars, so intraday rebalancing is economically
impossible and the buffer stays huge.

On Arc it is a **few cents in USDC, final in ~350 ms**. Divide the fixed cost by 10 000
and the optimal band divides by 21.5.

**The buffer collapses.** This repository quantifies that collapse, and does not ask you
to take it on faith.

---

## The counterintuitive part

Everyone assumes the saving is carry. It is not.

At a 6% cost of capital, carrying a million dollars for a month is noise next to execution
costs. The collapsing buffer is the visible result, not the cause.

**Execution cost falls 19.7% despite thirty times more orders.** Under square-root market
impact, many small orders cost less than a few large ones — and that regime only becomes
reachable once the fixed cost per rebalance collapses. On bank rails, those 2 879 orders
would cost seven times the entire budget.

Cheap finality does not make rebalancing incrementally cheaper. It unlocks a different
execution regime.

---

## Results

20 seeds × 6 walk-forward windows. Every parameter estimated only from data predating the
decision it informs — full report and limits in [`docs/BACKTEST.md`](./docs/BACKTEST.md).

| | Conservative pre-funding | NEAP | Δ |
|---|---|---|---|
| **Idle capital** | $1.74M | **$269k** | **−84.6%** |
| **ES 97.5%** | $77.8k | **$8.2k** | **−89.4%** |
| Total cost | $356k | **$269k** | −24.4% |
| Orders | 90 | 2 879 | +3 113% |

**Robust** — the capital reduction holds from −84.9% to −84.2% across the full sensitivity
range of the one uncalibrated parameter.

**Conditional** — the cost reduction moves between −13% and −38% over that same range, and
should never be quoted without it.

**Worse** — NEAP tolerates more threshold breaches than conservative pre-funding. That is
the optimiser applying the breach cost it was given, priced at $50 000. Raise the price,
get a thicker buffer.

---

## Architecture

Three sponsors. Remove any one and something breaks.

| | Role | Remove it and… |
|---|---|---|
| **Chainlink CRE** | The decision runs inside a TEE. Live balances, upcoming commitments and internal limits map a liquidity position precisely enough for a counterparty to trade against it — they never leave the enclave. What leaves is a signed report: an order commitment and metrics in basis points, never amounts. | the institution publishes its positions, and the product has no commercial reason to exist |
| **Arc (Circle)** | PvP settlement — both legs complete or neither does. Sub-second finality, gas denominated in USDC, which makes the fixed cost a *known number* inside the objective rather than an estimate. | Herstatt settlement risk returns and the thesis loses its premise |
| **Privy** | Role wallets whose policies allow three function selectors and nothing else. A stolen key passes authentication; it does not pass the policy. Separation of duties is enforced on-chain **and** at the wallet. | four-eyes control disappears |

**The vault never trusts the report.** Per-order cap, per-epoch cap, rolling 24-hour
window and a price-deviation check are applied independently — because a deranged model
produces a perfectly signed, perfectly absurd plan.

> The contract does not run the model. It constrains the model.

---

## Run it

```bash
npm run e2e          # full chain on a throwaway node: deploy → decide → sign → approve → execute
npm run dev          # landing on http://localhost:5173, dashboard on /app
npm test             # 151 TypeScript tests
npm run typecheck    # 0 errors
npm run cre:simulate # the confidential handler, in the TEE simulator
npm run backtest     # regenerates every number above (~15 min)

cd contracts && forge test   # 90 Solidity tests
```

**No `npm install`.** Node 24 runs the TypeScript directly, and the repository has no
JavaScript dependency outside the CRE workflow, which needs the Chainlink SDK. Contracts
use Foundry with `forge-std` as a submodule.

---

## What is real, what is not

Kept current on purpose. A judge will find these anyway; finding them written changes who
saw them first.

| | |
|---|---|
| Payment flows | **Synthetic.** No institution publishes flows by corridor. Compound-Poisson generator calibrated on public aggregates (ECB, World Bank), with five validity tests and a fixed seed. |
| Market impact `η` | **Not calibrated.** Arc's real book depth is unknown. Exposed as a parameter, sensitivity published beside every number that depends on it. |
| Confidential handler | **Simulated, successfully.** `cre workflow simulate` runs it in the TEE simulator. Deployment is waitlisted; the local simulator needs no enrolment. |
| Execution venue | **`MockFxVenue`**, deterministic, used by the backtest. StableFX is an API/SDK integration reserved to vetted institutions, so its adapter lives off-chain by design, not as a fallback. |
| Slow-rail settlement | The BRL corridor's T+2 latency is **priced but not simulated** — rebalances are instantaneous in the simulation, which mildly flatters that corridor. |

---

## Documentation

- [`docs/BACKTEST.md`](./docs/BACKTEST.md) — results with their limits
- [`docs/E2E.md`](./docs/E2E.md) — trace of the end-to-end run
- [`docs/DECISIONS.md`](./docs/DECISIONS.md) — 24 architecture decisions, each with its reason
- [`docs/MAINNET.md`](./docs/MAINNET.md) — the Arc mainnet commitment and what ships under it
- [`docs/SPEC.md`](./docs/SPEC.md) — full technical specification

---

## Licence

MIT — [`LICENSE`](./LICENSE).

The two webfonts served by the site are redistributed under the SIL Open Font License 1.1,
and the contracts are unaudited: [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md).

---

<sub>A *neap tide* is the tide of smallest range — the moment when the swing between high
and low water is at its least. That is what this engine does to a treasury buffer.</sub>
