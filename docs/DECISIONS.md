# Architecture decision log

Short form: decision, reason, consequence. The detail lives in [`SPEC.md`](./SPEC.md) §14.

| # | Decision | Reason, in one line |
|---|---|---|
| D1 | Name: **NEAP** | a *neap tide* is the tide of smallest range — exactly what the engine does to a treasury buffer |
| D2 | **Hybrid** scope: 3 stablecoin currencies + 1 "slow rail" corridor | creates the trade-off between two fixed-cost regimes — without it the optimiser has nothing to optimise |
| D3 | Bands by **numerical solving, warm-started** by analytic Miller-Orr | fast, general, and Miller-Orr doubles as a regression test |
| D4 | **ES 97.5% (FRTB) by Filtered Historical Simulation** | normal VaR underestimates the tail; FRTB made the same choice for the same reason |
| D5 | **The TEE computes only what depends on state**; parameters are committed on-chain by hash | a confidentiality boundary stateable in one sentence and verifiable |
| D6 | Commitment + lot quantisation + jitter | protects the amount without overplaying; residual leakage documented |
| D7 | **The contract is the authority** on roles; Privy = custody + UX | makes authorisation verifiable and the contract substantial |
| D8 | `IFxVenue`: `MockFxVenue` as the reference implementation | the mock is required by the backtest anyway — not a fallback |
| D9 | The risk engine is a **pure function**, with two possible hosts | the plan B costs nothing because it is the same code |
| D10 | Backtest **walk-forward, 20 seeds, 95% CI**, plus a reference policy calibrated on the realised window | removes lookahead bias and gives the claimed gain a frame of reference |
| D11 | **TypeScript** for the engine; Python reserved for calibration exploration | the pure function must be portable into the CRE handler and reusable by the dashboard (D9) |
| D12 | **The 15-minute epoch is justified quantitatively**, not by convention | the band model requires the one-period flow shock to be small against the band width; at daily granularity the EUR shock is ±$1.5M against a $100k band, and the policy degenerates |
| D13 | **Breach cost is priced as an analytic expectation, not counted in simulation** | the breach probability at the optimum is of the order of 10⁻⁵ to 10⁻⁸; 120,000 simulated periods do not measure it, so the term and its gradient were zero everywhere |
| D14 | **Breach cost is an absolute quantity**, not a multiple of γ | the spec proposed c_b = 250·γ; when γ collapses by 10⁴ on the fast rail, c_b would collapse with it — yet a missed payment costs the same whatever rail is used to fix it |
| D15 | **Increasing sequence over the (epoch, nonce) pair**, not over the epoch alone | the crisis path (§2.3) requires an off-cycle report between two epochs; strict epoch growth would forbid it |
| D16 | **The idempotency check comes before the sequence check** | a replay must fail for the right reason; an incidental rejection by the sequence check would mask the real guarantee |
| D17 | **A genuinely rolling window** (24 hourly buckets) rather than a periodic reset | a reset window lets twice the limit through on either side of a boundary — one hole too many for a constraint meant to bound a compromised operator |
| D18 | **`grossNotional` is published in the clear**, by exception to the relative-quantities principle | the approval threshold applies to the size of the plan, and the orders are sealed until execution; without this field the treasurer would approve blind, which would not be an approval. The decomposition stays protected |
| D19 | **A plan is atomic**: one failing order fails the whole plan | partial execution — selling euros without buying the intended pounds — would leave a position nobody decided, worse than inaction |
| D20 | **The `COMPENSATED` state is removed** from the vault state machine | StableFX's PvP is documented atomic: "both sides complete or neither does" |
| D21 | **`ArcFxVenue` is not an on-chain contract** but an off-chain adapter (API RFQ → typed-data intent → Permit2 settlement) | StableFX is an API/SDK integration: "you don't need to interact with smart contracts directly". `IFxVenue` stays right for the mock and for any genuinely on-chain venue, but it does not describe StableFX |
| D22 | **The L4 target is `cre workflow simulate`**, a testnet deployment being a bonus | the local simulator requires no registration, and the ETHGlobal track explicitly accepts a successful simulation. Beta registration opens 90 testnet days — useful but not on a three-day critical path |
| D23 | **The attestation is verified by DON consensus**, not by the contract | "DON consensus verifies attestations from the enclave". `IAttestationVerifier` remains an honest extension point, but the real trust model must be stated as it is |
| D24 | **Mocks never ship to mainnet; the mainnet profile deploys `PausedFxVenue` and pauses the system** | on mainnet USDC and EURC are real: a fake venue there could source no liquidity and would look like a trap if anyone funded it. An explicit refusal tells the truth — deployed, verifiable, provably inoperative. And these contracts are unaudited: deploying them is acceptable, putting funds in them is not |

## Still open

- Which destination chains CRE supports, and Arc in particular.
