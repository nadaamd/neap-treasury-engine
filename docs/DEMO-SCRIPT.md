# Demo video — script and shooting guide

3 minutes. Narration in English, shooting notes in French.

---

## Script

### 0:00 — Landing, hero

> To send money instantly across borders, you have to hold the destination currency before the money arrives. Every corridor, every currency, all day. That cash earns nothing — and it carries a currency position nobody chose.

### 0:15 — Slow scroll

> Treasuries size that buffer the way they always have. Look at the worst day of last quarter, provision that much, move on. It works. It's expensive.

### 0:28 — The two bars collapse

> NEAP replaces the heuristic with stochastic control. The rebalancing band isn't a setting — it's the minimum of one cost function: carry, fixed cost, execution, FX risk, breach risk. Twenty seeds, six walk-forward windows: idle capital drops **84.6 percent**.

### 0:45 — "Why now" section

> Band width grows as the **cube root** of the fixed cost per rebalance. On correspondent banking rails, that's tens of dollars. On Arc it's a few cents, final in 350 milliseconds. Divide the fixed cost by ten thousand — the band divides by twenty-one.

### 1:00 — `/app`, playing

> This is the engine running. Three currencies, three bands — solved from the cost function, not typed in. The balances drift with simulated payment flows.

### 1:12 — Click **Shock**

> Now a shock. Two and a half million leaves the Brazilian corridor. The balance falls through the lower threshold — and that's the moment the engine decides.

### 1:25 — The order appears in the log

> It proposes one order, sized to return to **target**, not to the threshold. That's Miller-Orr: you don't rebalance at the edge, you'd never stop.

### 1:35 — Sliders: κ, then breach cost

> Raise risk aversion — the bands tighten. Raise the cost of a missed payment — the buffer thickens. These re-solve the optimisation server-side. Nothing on this screen is a hard-coded number.

### 1:50 — Terminal, `npm run e2e`

> Every piece is unit-tested. This proves they fit together. Deploy, configure, decide, sign, submit, approve, execute — on a throwaway chain, in five seconds.

### 2:02 — The terminal scrolls

> The decision runs inside a **Chainlink CRE** confidential handler. Live balances,
> commitments, internal limits — they never leave the enclave. What leaves is a signed
> report: a commitment to the orders, and metrics in basis points. Never amounts.

### 2:14 — The refusals appear

> **Privy** holds the role wallets. Watch the guards fire. Self-approval by the operator:
> refused. Execution before approval: refused. Replay: refused.

### 2:24 — Final green line

> And the vault never trusts the report. Per-order cap, epoch cap, rolling 24-hour window,
> price deviation against the oracle. Because a broken model produces a perfectly signed,
> perfectly absurd plan.

### 2:36 — Back to the landing, mechanism section

> One last thing — the saving isn't carry. At six percent a year, carrying a million for a
> month is noise. Execution cost falls **nineteen point seven percent despite thirty times
> more orders**, because under square-root impact many small orders beat a few large ones.
> Cheap finality doesn't make rebalancing cheaper. It unlocks a different execution regime.

### 2:50 — "What is real" table

> The flows are synthetic — no institution publishes theirs. The impact parameter isn't
> calibrated, so its sensitivity sits next to every number that depends on it.

### 2:57 — End card: live URL + GitHub

> NEAP. The band is the minimum of the objective.

**≈ 430 mots, soit 2:50 à débit calme. Les 10 s restantes sont la marge — ne pas la remplir.**

---

## Préparer la machine

```bash
Réglages → Concentration → Ne pas déranger     # sinon une notification finit dans la vidéo

cd ~/ethonline-2026 && npm run dev
```

Filmer en **local**, pas sur Vercel : l'épisode se calcule en 0,67 s en local contre 2,6 s
en ligne. Deux secondes de page figée, ça se voit.

**Navigateur** — fenêtre 1920×1080, barre de favoris masquée (`⇧⌘B`), profil propre sans
extensions. Charger `/app` **une fois avant d'enregistrer** : ça met les polices en cache
et résout un premier épisode.

**Terminal** — police 18-20 pt, fenêtre effacée (`⌘K`), même largeur que le navigateur pour
que le montage ne saute pas.

---

## Enregistrer

QuickTime → *Nouvel enregistrement de l'écran* suffit. OBS seulement pour une vignette
webcam.

**Image et voix séparément.** Une prise vidéo muette, puis la voix par-dessus. Chercher la
prise parfaite avec commentaire en direct fait perdre une heure ; en deux passes, chaque
plan se refait en trente secondes.

| Plan | Durée | Remarque |
|---|---|---|
| Scroll de la landing | 25 s | Lent. Marquer un arrêt sur les barres qui s'effondrent — elles ne se jouent qu'une fois. |
| Tableau de bord + **Shock** | 40 s | Le plan qui compte. Le bouton Shock repositionne juste avant le choc et relance la lecture seul : un seul clic. |
| Les trois curseurs | 20 s | Lentement, un par un. |
| `npm run e2e` | 10 s | 5,2 s en temps réel, 64 lignes. Aucune accélération nécessaire. |

---

## Les pièges de ce projet

**`npm run backtest` ne se filme pas.** 15 minutes. Les chiffres sont déjà sur la landing,
c'est fait pour.

**`npm run cre:simulate` ne marche pas tel quel.** La CLI est dans `~/.cre/bin` mais absente
du `PATH`, et le SDK n'est pas installé dans `cre/workflow`. Il faudrait :

```bash
export PATH="$HOME/.cre/bin:$PATH"
cd cre/workflow && bun install
```

Sinon, réutiliser la trace déjà capturée dans [`../cre/README.md`](../cre/README.md) — le
track accepte une preuve de simulation, pas nécessairement une simulation filmée.

**Respecter la taille de fenêtre.** Le bloc vivant du tableau de bord est conçu pour tenir
dans une hauteur d'écran au-delà de 1100 px de large et 720 px de haut. En dessous, la mise
en page repasse en colonne et le plan est cassé.

---

## Monter

- Couper le temps mort pendant le calcul d'un épisode, ou le couvrir par la narration.
- Carte de titre 2 s : **NEAP — intraday multi-currency treasury engine**.
- Carte de fin avec l'URL live et le lien GitHub, tenue 3 s.
- Pas de musique : sur une démo technique, elle couvre la voix et n'ajoute rien.
- Export 1080p, H.264.
