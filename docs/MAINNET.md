# Mainnet deployment obligation — Arc

> Sponsor rule: any winning project must be deployed on mainnet **before 30 September
> 2026**. During the hackathon, testnet is enough. The Arc team supports the transition
> after the event.

## The calendar, which is tight on both sides

| Date | Event |
|---|---|
| 10 September 2026 | Arc mainnet **does not exist yet** |
| 16 September 2026 | public mainnet opens; Circle then publishes chain ID, RPC and explorer |
| 30 September 2026 | deadline for mainnet deployment in case of a prize |

The usable window is therefore **fourteen days**, and it starts after the hackathon ends.
None of what follows is on the critical path to submission — but committing to an Arc prize
means committing to that window.

## Networks

| | Testnet | Mainnet |
|---|---|---|
| Chain ID | 5042002 | not published to date (5042 according to third-party sources) |
| RPC | published | published on 16 September |
| Explorer | testnet.arcscan.app | published on 16 September |
| Gas | sponsored by Circle's Gas Station, or faucet | **real USDC**, bridged via CCTP |

The validator set is permissioned — eleven institutions chosen by Circle — but nothing in
the documentation says that **contract deployment** is. That has to be checked on the 16th,
and it is the only point that could change everything.

## What will be deployed, and what will not

This is where the rule has an architectural consequence, and it deserves to be taken
seriously rather than treated as a formality.

**Not going to mainnet: `MockERC20` and `MockFxVenue`.** On mainnet, USDC and EURC are real
tokens. A fake execution venue there would be a contract unable to source any liquidity,
and it would look like a trap if anyone funded it. The mock is a backtest and demo
instrument, not a production artefact.

**Going to mainnet**: `TreasuryPolicy`, `ReportVerifier`, `RebalanceVault` and an explicit
execution venue.

**The mainnet venue is the hard part.** StableFX is an API integration restricted to
verified institutions, and its adapter lives off-chain (D21). Until access is granted, the
vault deployed on mainnet has no credible counterparty. So `PausedFxVenue` is deployed — a
venue that refuses every execution with an explicit error. The system is deployed,
verifiable and **provably inoperative** until an administrator wires a real venue in
through `setVenue`.

Saying "deployed and deliberately inert" is honest. Deploying a mock on mainnet while
implying that it executes is not.

## Safety rule, non-negotiable

**These contracts are not audited.** Deploying them on mainnet is acceptable; putting real
funds in them is not. A mainnet deployment is a deployment, not a go-live:

- the vault ships **paused** (`GUARDIAN.pause()` immediately after deployment);
- no token is transferred to it;
- the per-currency limits stay at zero until a policy is applied.

A hackathon project that deploys to mainnet and puts money in it because a contest rule
pushes it there commits exactly the mistake the rest of this repository works to avoid.

## Operational checklist

- **Real USDC on Arc mainnet** for gas. Deploying four contracts plus an inert venue stays
  in the order of a few dollars, but it is not zero, and it has to be bridged via CCTP.
- A deployment key distinct from any personal key.
- Source verification on the explorer, as soon as it is published.

## What is ready

The deployment script handles three profiles from one source — `anvil` for the end-to-end
scenario, `arc-testnet` for the demo, `arc-mainnet` for the post-hackathon obligation. The
mocks are instantiated only on the first two, and the script itself guarantees that, not a
convention.
