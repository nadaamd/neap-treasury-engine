# L6 — operational governance, Privy org wallets

## Why two layers of control

Separation of duties is already enforced on-chain (D7): `TreasuryPolicy` refuses to let one
address hold both `RISK_OFFICER` and `TREASURER`, and the vault refuses an unapproved
execution. So why restate it at the wallet level?

**Because the two layers fail differently.**

| | What it protects | What it cannot see |
|---|---|---|
| Contract | who may do what, within which amount limits | a transaction not addressed to it |
| Privy policy | which transactions this key may sign at all | the business coherence of an allowed call |

A compromised key passes authentication. It can sign a transfer to an arbitrary address,
call a foreign contract, drain a balance — and the contract will never know, because those
transactions never go through it. A policy that allows only three selectors towards two
addresses does refuse them.

Neither layer replaces the other.

## What each role may sign

| Role | Destination | Functions | Quorum |
|---|---|---|---|
| `OPERATOR` | vault | `submit`, `execute` | 1 / 1 |
| `TREASURER` | vault | `approve` | **2 / 3** |
| `RISK_OFFICER` | policy | `queueCurrencyPolicy`, `queueRiskParams`, `commitBandParams` | 1 / 2 |

Every policy adds a third condition that is easy to forget: **strictly zero native value**.
A wallet allowed to *call* a contract stays allowed to *send* it value — and on Arc, gas is
USDC, so native value is money.

Every policy ends with an unconditional explicit denial. An allow-list with no final denial
depends on the engine's evaluation order, and it is better not to depend on it.

Only one role requires multiple signatures: the treasurer. It is the most consequential
action in the system. A quorum on the operator would weigh down every fifteen-minute epoch
without protecting anything the contract does not already protect.

## Selectors, checked in both directions

The allowed selectors are computed in TypeScript with our own keccak256, then **checked
against the compiled bytecode** by the Solidity conformance suite. A mistyped signature
would produce a policy that blocks exactly what it was meant to permit — and the error
would only surface as an approval refused in the middle of a demo.

```
0x6d7885e8  OPERATOR      submit(...)
0xfc8d9160  OPERATOR      execute(...)
0xa53a1adf  TREASURER     approve(bytes32)
0x984103d1  RISK_OFFICER  queueCurrencyPolicy(...)
0x5eb8879d  RISK_OFFICER  queueRiskParams(...)
0x97b00759  RISK_OFFICER  commitBandParams(bytes32)
```

## Provisioning

```bash
cp privy/.env.example privy/.env   # fill in PRIVY_APP_ID and PRIVY_APP_SECRET
node privy/scripts/provision.ts <vault-address> <treasury-policy-address>
```

The script creates one policy and one wallet per role, then writes `privy/wallets.json`. It
fails loudly if that file already exists, rather than silently creating duplicates.

Next step, to be done deliberately: grant the on-chain roles to those addresses through
`TreasuryPolicy.grantRole`. The contract will refuse to grant `RISK_OFFICER` and
`TREASURER` to the same address — that is the invariant, and it applies to the Privy
wallets too.

## To confirm at the first real provisioning

The documentation establishes that `field_source: 'ethereum_calldata'` exists and that an
ABI must be supplied, without fixing the name of the field carrying the called function. It
is isolated in a single constant, `CALLDATA_FUNCTION_FIELD`. If the API rejects it, it will
say so, and one line changes.
