# Walk-forward backtest — reference run

> `npm run backtest` · 20 seeds × 6 windows. Reproducible: seeds are fixed.

```


════════════════════════════════════════════════════════════════════════════════════════════════
  NEAP — walk-forward backtest · 20 seeds × 6 windows
════════════════════════════════════════════════════════════════════════════════════════════════

  Averages per evaluation window, with 95% confidence intervals.

  Policy                                           │  Idle capital      │  ES 97.5%          │  Total cost        │  Execution  │  Breaches  │  Rebal.
  ─────────────────────────────────────────────────┼────────────────────┼────────────────────┼────────────────────┼─────────────┼────────────┼────────
  STATIC      (conservative pre-funding)           │  $1.74M ± $109.7k  │  $77.8k ± $8.0k    │  $356.2k ± $10.8k  │  $330.4k    │  0.03      │  90    
  CALENDAR    (end-of-day rebalancing)             │  $2.27M ± $66.9k   │  $114.6k ± $12.9k  │  $419.8k ± $2.7k   │  $386.2k    │  3.24      │  90    
  NEAP       (optimised bands, signal-driven)      │  $269.3k ± $3.6k   │  $8.2k ± $876.8    │  $269.3k ± $1.5k   │  $265.3k    │  1.36      │  2879  
  CLAIRVOYANT (calibrated on the realised window)  │  $270.0k ± $3.8k   │  $8.2k ± $852.8    │  $269.1k ± $1.6k   │  $265.1k    │  1.38      │  2875  

  NEAP against conservative pre-funding:

    idle capital         -84.6%
    ES 97.5%             -89.4%
    total cost           -24.4%
    execution cost       -19.7%
    number of orders     +3113.2%

  Cost of estimation uncertainty
  ────────────────────────────────────────────────────────────────────────────────────────────
    NEAP against calibration on the realised window: 0.05% ± 0.19%
    The interval contains zero: calibrating on the past costs nothing measurable here.

  How to read this
  ────────────────────────────────────────────────────────────────────────────────────────────
    Idle capital and FX risk collapse; total cost falls more modestly. That is not
    a contradiction: at 6% a year, carrying a million dollars over a few weeks weighs
    little against execution costs. The value of the released capital is not read in
    the carry cost, it is read in the capital itself.

    Execution cost falls *despite* far more orders, and that is the central
    mechanism: under square-root impact, many small orders cost less than a few large
    ones. That regime is only reachable because the fixed cost of a rebalance
    collapsed on the stablecoin rail — on a correspondent-bank rail, thirteen hundred
    orders would on their own cost more than everything else.

    NEAP tolerates more breaches than conservative pre-funding, and that is the
    optimiser doing its job: the breach cost used is $50,000, and at the optimum the
    breach probability scales as 1/c_b. An institution that prices a missed payment
    higher mechanically gets a thicker buffer.

  Assumptions — read these before the numbers
  ────────────────────────────────────────────────────────────────────────────────────────────
    Payment flows          synthetic, compound Poisson calibrated on public aggregates
    FX market              GARCH(1,1) with Student innovations, seed independent of flows
    Cost of capital        6.0% per year
    Market impact          UNCALIBRATED — eta = 0.002 on the euro
                           (relative cost of an order consuming the full depth)
    Slow rail              BRL, fixed cost $25, T+2 settlement
    Calibration            expanding window, 90 warm-up days
    Evaluation             30 days per window, never seen during calibration

  Sensitivity to the impact coefficient — the model's one invented parameter
  ────────────────────────────────────────────────────────────────────────────────────────────
    eta × 0.5   capital   -84.9%   total cost   -13.0%
    eta × 1.0   capital   -84.6%   total cost   -24.4%
    eta × 2.0   capital   -84.2%   total cost   -38.0%

  Duration: 876.2 s

  Results written to results/backtest.json
```
## What these numbers say, and what they do not

### The robust result: capital

The reduction in idle capital — **−84.6%** — is stable across the whole sensitivity range
tested: −84.9% at `eta × 0.5`, −84.2% at `eta × 2`. It therefore does not depend on the
model's only uncalibrated parameter. This is the figure to lean on.

The confidence interval is tight (± $3.6k on $269k, i.e. ± 1.3%) because the optimised
policy converges to the same target whatever the seed: the optimal buffer is a property of
the flow structure, not an accident of the sample.

### The conditional result: total cost

The fall in total cost — **−24.4%** — moves between −13% and −38% depending on the impact
coefficient. It is therefore **conditional on an assumption that cannot currently be
verified**. Any presentation of this figure must come with its sensitivity range; publishing
it alone would be misleading.

### The mechanism, which is not the one expected

The starting intuition was "the buffer collapses, so carry falls". Carry does fall, but it
was barely weighing anything: at 6% a year, tying up a million dollars over a thirty-day
window costs a few thousand dollars, against several hundred thousand of execution costs.

The gain comes from elsewhere. Execution cost falls by **19.7% despite thirty times more
orders**. Under square-root market impact, splitting a rebalance into many small orders is
structurally cheaper than executing it in a few large blocks. That regime is only reachable
because the fixed cost of a rebalance has collapsed: on a correspondent-bank rail at $25 an
order, two thousand eight hundred orders would on their own cost seven times the entire
budget.

**Sub-second finality and gas at a few cents do not make rebalancing "cheaper" at the
margin. They make an entirely different execution regime reachable.**

### Estimation error is not the binding factor

`0.05% ± 0.19%`: the gap between calibrating on the past and calibrating on the realised
window contains zero. In other words, a policy that had known the distribution of the coming
period would not have done better. The flow structure is stable enough that walk-forward
costs nothing.

On a sample reduced to two seeds, that same quantity was −1.87% ± 0.77% — an apparently
significant gap, in reality noise. That is the argument for twenty seeds and confidence
intervals: a single run would have produced a wrong number with the appearance of precision.

### What is worse, and must be said

**NEAP tolerates more breaches than conservative pre-funding**: 1.36 against 0.03 per window.
This is not an implementation defect, it is the optimiser applying the breach cost it was
given ($50,000). At the optimum, the breach probability scales as `1/c_b` — an institution
that prices a payment incident higher mechanically gets a thicker buffer. The parameter is
exposed and its effect is demonstrated in a unit test.

Note that the calendar policy does worse still (3.24 breaches): looking at the state only
once a day lets the balance drift unwatched between checks.

### Known limitations

- The payment flows are **synthetic**. No institution publishes its flows per corridor; the
  generator is calibrated on public aggregates and its statistical properties are tested, but
  this is not real data.
- The impact coefficient is **not calibrated**: Arc's real book depth is unknown.
- The slow rail is modelled by its cost and its latency, but the **T+2 settlement delay is not
  simulated** — rebalances are instantaneous in the simulation. This mildly flatters the
  corridor without a stablecoin.
- The path bootstrap is independent and destroys the autocorrelation of the flows. A block
  bootstrap would preserve it, at the price of a block-length parameter to calibrate.
