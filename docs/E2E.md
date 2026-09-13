# End-to-end scenario — reference trace

> `npm run e2e`. Ephemeral local node, deterministic anvil accounts.

```


01  Starting the local node
    block 0

02  Deploying the system
    policy 0x5FbDB2315678afecb367f032d93F642f64180aa3
    verifier 0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0
    vault 0x0DCd1Bf9A1b36cE34237eEaFef220932846BCD82

03  Separation of duties — the contract refuses the overlap
    refused: SeparationOfDutiesViolated
    the deployer holds RISK_OFFICER, so it cannot be treasurer
    separate treasurer: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8
    DON signer: 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC

04  The risk officer queues the policy
    two pending changes, 24-hour timelock

05  The timelock elapses, then the changes apply
    policy version: 2

06  Funding the vault
    USDC 20,000,000 · EURC 92,000
    equivalent 100,000 — below the lower threshold of 400,000

07  The engine decides
    PROPOSE — 1 order
    buy 458,620 EURC against 500,000 USDC
    ES 6 → 36 bps · commitment 0x42fd8bf64d581856…

08  The quorum signs the report
    identical EIP-712 digest on both sides: 0x9795f2ebe3e1d8b9…

09  The operator submits the report
    plan 0xdc218c7e9e81719e… · status AwaitingApproval

10  Notional exceeds the threshold: human approval required
    execution refused before approval: WrongStatus
    self-approval refused: Unauthorized
    approved by the treasurer · status Ready

11  Execution
    USDC 20,000,000 → 19,500,000   (-500,000)
    EURC 92,000 → 551,632   (+459,632)
    status Settled

12  Replay is refused
    refused: WrongStatus

13  Checks
    ✔ the plan is settled
    ✔ the amount spent matches the plan
    ✔ the amount received meets the minimum
    ✔ the realised rate is close to the reference rate

✔ Full chain verified: deployment → policy → decision → signature → submission → approval → execution

```
