# L4 — Chainlink CRE confidential handler

## Status

| Piece | Status |
|---|---|
| `handler/types.ts` — data contract, confidentiality boundary | ✅ |
| `handler/buildReport.ts` — treasury state → signable report | ✅ 14 tests |
| `workflow/` — SDK envelope (`handlerInTee`, two secrets, two HTTP calls) | ✅ |
| `cre workflow simulate` | ✅ **run, decision produced** |

The core knows nothing about the SDK: it takes a state and returns a report, so it is
testable with no enclave, no network and no chain. That is the consequence of D9 — the
engine is a pure function, and so is this adapter. The CRE envelope reduces to three
gestures: fetch a secret, make two HTTP calls, call `buildReport`.

## Simulation evidence

```
2026-09-10T12:48:20Z [SIMULATION] Running trigger trigger=cron-trigger@1.0.0
  Trigger requested TEE Execution: AWS Nitro in us-west-2
2026-09-10T12:48:20Z [USER LOG] decision: PROPOSE — deviation from the bands

✓ Workflow Simulation Result:
"PROPOSE — 1 order(s), commitment 0x28fd83e0…"
```

To reproduce: `npm run cre:simulate`, with the dashboard running (`npm run dev`), since
the enclave calls its two endpoints.

## Install prerequisites

```bash
brew install bun
curl -sSL https://app.chain.link/cre/install.sh | bash
```

The `@chainlink/cre-sdk` package is installed in this folder only. It is the repository's
first JavaScript dependency, and it is confined here: `data/`, `engine/` and `app/` stay
dependency-free.

## Shape of the handler

The real API is **synchronous** — `.result()` everywhere, no `await`. That is consistent
with the determinism requirement: the enclave's result is attested and then verified by
DON consensus, so on identical inputs it must produce identical output.

```ts
cre.handlerInTee(
  cronTrigger.trigger({ schedule: config.schedule }),
  (runtime: TeeRuntime<Config>) => {
    const token = runtime.getSecret({ id: config.treasuryTokenSecretId }).result().value
    const seed = runtime.getSecret({ id: config.saltSeedSecretId }).result().value

    const treasury = JSON.parse(httpGet(runtime, config.treasuryUrl, token)) // confidential
    const market = JSON.parse(httpGet(runtime, config.marketUrl))           // public

    const out = buildReport({ treasury, market, chain, saltSeed: seed, now: market.timestamp })

    runtime.usingTheDons().report({ /* … */ }).result() // only the report leaves
  },
  [{ tee: 'nitro', regions: ['us-west-2'] }],
)
```

## Platform constraints

- **11 secrets and 5 HTTP calls** maximum per invocation. NEAP uses two and two — ample
  margin.
- **The workflow logic is not confidential**, only the data is. That is exactly what NEAP
  needs: the positions are protected, not the model.
- The attestation is verified by **DON consensus**, not by the consuming contract (D23).

## What is protected, and why

Live balances per currency, known upcoming commitments, internal limits. Taken separately,
each is innocuous. Published together, they draw a complete map of the institution's
liquidity position — enough to trade against it. That conjunction is what justifies the
enclave.

Left outside: FX rates, gas, indicative quotes. Drawing the boundary rather than putting
everything inside the enclave out of caution is also a way of showing that its cost is
understood.
