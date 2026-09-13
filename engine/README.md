# Quantitative engine (L2)

Pure function, no I/O — runnable inside the CRE handler or in a local runner (D9).

- `risk/`     EWMA volatility, Ledoit-Wolf covariance, ES 97.5% by FHS
- `bands/`    band solving (Monte-Carlo, warm-started by Miller-Orr)
- `policy/`   objective function J and the decision rule
- `backtest/` walk-forward protocol and the four compared policies
- `onchain/`  keccak256, ABI encoding, EIP-712 — mirrors the contracts
