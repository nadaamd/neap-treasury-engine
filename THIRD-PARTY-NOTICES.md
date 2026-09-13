# Third-party notices

The MIT licence in [`LICENSE`](./LICENSE) covers the code in this repository. It does
not cover the components below, which ship with or alongside it under their own terms.

## Fonts, redistributed in this repository

Two webfont files are served from `app/public/fonts/`. Both are under the **SIL Open
Font License 1.1**, whose full text travels with them.

| Font | Copyright | Licence |
|---|---|---|
| Young Serif | Copyright 2023 The Young Serif Project Authors — [source](https://github.com/noirblancrouge/YoungSerif) | [`OFL-youngserif.txt`](./app/public/fonts/OFL-youngserif.txt) |
| Archivo | Copyright 2020 The Archivo Project Authors — [source](https://github.com/Omnibus-Type/Archivo) | [`OFL-archivo.txt`](./app/public/fonts/OFL-archivo.txt) |

The OFL permits embedding and redistribution with software, and forbids selling the
fonts on their own. Both conditions are met here: the files are subsetted to Latin and
served as part of the site, never offered for download as fonts.

The licence text must accompany the font files, which is why the two `OFL-*.txt` files
sit in the same directory as the `.woff2` they cover rather than in a documentation
folder.

## Dependencies, not redistributed

Fetched at build or test time, under their own licences:

| Component | Where | Licence |
|---|---|---|
| `forge-std` | `contracts/lib/` (git submodule) | MIT / Apache-2.0 |
| `@chainlink/cre-sdk` | `cre/workflow/decision/` | see package |
| `viem`, `zod` | `cre/workflow/decision/` | MIT |

Everything outside `cre/workflow/` has no JavaScript dependency at all.

## What this repository is not

The contracts have **not been audited**. The MIT licence's disclaimer of warranty is not
a formality here: this is hackathon code, and the deployment script deliberately ships
the mainnet profile paused, with an inert venue and no funds
([`docs/MAINNET.md`](./docs/MAINNET.md)).

Backtest figures are computed on **synthetic** payment flows and one uncalibrated market
impact parameter. They are reproducible, documented and bounded — they are not a claim
about any real institution's treasury.

## Sponsor marks

`app/public/logos/` holds the marks of the three sponsors, used to identify them in the
architecture section:

- `chainlink.svg` — the Chainlink symbol, from chain.link/brand-assets, unmodified.
- `privy.png` — the Privy mark, taken from the privy.io icon, unmodified.
- `arc.svg` — the Arc wordmark, from arc.io. **Modified**: the published file is white on
  a transparent gradient, intended for dark backgrounds; the fill is replaced by a solid
  colour so that it reads on a light page.

These are trademarks of their respective owners, reproduced to identify the sponsors of an
ETHOnline 2026 submission. They are not covered by this repository's MIT licence.
