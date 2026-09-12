/**
 * Tableau de bord FLOAT — animation d'un épisode calculé par le serveur.
 *
 * Aucun calcul métier ici : les bandes, les décisions, le risque et les coûts viennent
 * du moteur. Le client anime, il ne décide pas — sans quoi la démonstration montrerait
 * une réimplémentation approximative plutôt que le système lui-même.
 */

const CURRENCIES = ['EUR', 'GBP', 'BRL'];
const COLOR = { EUR: 'var(--eur)', GBP: 'var(--gbp)', BRL: 'var(--brl)' };
const EPOCHS_PER_DAY = 96;

const state = {
  episode: null,
  index: 0,
  timer: null,
  loading: false,
};

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ */
/*                               Icônes                               */
/* ------------------------------------------------------------------ */

/**
 * Glyphes dessinés, d'un seul traitement — silhouettes pleines sur une grille de 16.
 *
 * Les caractères Unicode qui servaient d'icônes (▶, ❚❚, ⚡, ■) prenaient la police du
 * système : chaque plateforme en rendait une variante différente, avec sa propre chasse
 * et son propre alignement optique. Un jeu dessiné ne dépend de rien.
 */
const ICON = {
  play: 'M5 3.4v9.2L13 8z',
  pause: 'M5 3.4h2.2v9.2H5zM8.8 3.4H11v9.2H8.8z',
  step: 'M4.6 3.4v9.2L11 8zM11.9 3.4h1.5v9.2h-1.5z',
  bolt: 'M9.1 1.4 4 8.9h3.1l-.8 5.7L12.2 7H8.4z',
};

function icon(name) {
  return `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" d="${ICON[name]}"/></svg>`;
}

function label(id, name, text) {
  $(id).innerHTML = `${icon(name)}<span>${text}</span>`;
}

function swatch(color) {
  return `<svg class="swatch" viewBox="0 0 10 10" aria-hidden="true" focusable="false"><rect width="10" height="10" rx="2" fill="${color}"/></svg>`;
}

/* ------------------------------------------------------------------ */
/*                              Formatage                             */
/* ------------------------------------------------------------------ */

const money = (x) => {
  const a = Math.abs(x);
  if (a >= 1e6) return `${(x / 1e6).toFixed(2)} M$`;
  if (a >= 1e3) return `${(x / 1e3).toFixed(0)} k$`;
  return `${x.toFixed(0)} $`;
};

const signed = (x) => (x >= 0 ? `+${money(x)}` : `−${money(-x)}`);

function clockLabel(t) {
  const day = Math.floor(t / EPOCHS_PER_DAY);
  const minutes = (t % EPOCHS_PER_DAY) * 15;
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `J+${day}  ${hh}:${mm}`;
}

/* ------------------------------------------------------------------ */
/*                          Jauge de bande                            */
/* ------------------------------------------------------------------ */

function gauge(bands, balance) {
  const w = 100;
  const span = Math.max(bands.upper * 1.35, balance * 1.15, 1);
  const x = (v) => Math.max(0, Math.min(w, (v / span) * w));

  const lo = x(bands.lower);
  const tgt = x(bands.target);
  const hi = x(bands.upper);
  const pos = x(balance);
  const outside = balance < bands.lower || balance > bands.upper;

  return `
    <svg class="gauge" viewBox="0 0 100 22" width="100%" height="34" preserveAspectRatio="none">
      <rect x="0" y="7" width="100" height="8" fill="var(--panel-2)" rx="2"/>
      <rect x="0" y="7" width="${lo.toFixed(2)}" height="8" fill="var(--zone-low)"/>
      <rect x="${lo.toFixed(2)}" y="7" width="${Math.max(hi - lo, 0.4).toFixed(2)}" height="8" fill="var(--zone-ok)"/>
      <rect x="${hi.toFixed(2)}" y="7" width="${Math.max(100 - hi, 0).toFixed(2)}" height="8" fill="var(--zone-high)"/>
      <line x1="${tgt.toFixed(2)}" y1="4" x2="${tgt.toFixed(2)}" y2="18" stroke="var(--dim)" stroke-width=".6" stroke-dasharray="1.5 1.5"/>
      <rect x="${Math.max(pos - 0.55, 0).toFixed(2)}" y="2" width="1.1" height="18"
            fill="${outside ? 'var(--bad)' : 'var(--ok)'}"/>
    </svg>`;
}

/* ------------------------------------------------------------------ */
/*                               Rendu                                */
/* ------------------------------------------------------------------ */

function renderCards(step, bands) {
  $('cards').innerHTML = CURRENCIES.map((c) => {
    const b = bands[c];
    // On montre le solde constaté avant décision : c'est celui qui déclenche l'action.
    const bal = step.observed[c];
    const settled = step.balances[c];
    const outside = bal < b.lower || bal > b.upper;
    const acted = step.actions.some((a) => a.currency === c);
    const badge = bal < 0
      ? '<span class="badge bad">breach</span>'
      : acted
        ? '<span class="badge warn">rebalanced</span>'
        : outside
          ? '<span class="badge warn">outside band</span>'
          : '<span class="badge ok">in band</span>';

    return `
      <div class="card ${bal < 0 ? 'hot' : ''}">
        <div class="ccy">
          <b style="color:${COLOR[c]}">${c}</b>
          ${badge}
        </div>
        <div class="bal num">${money(bal)}</div>
        <div class="sub num">epoch flow ${signed(step.flows[c])}${
          acted ? ` · pulled back to ${money(settled)}` : ''
        }</div>
        ${gauge(b, bal)}
        <div class="ticks num">
          <span>lower ${money(b.lower)}</span>
          <span>target ${money(b.target)}</span>
          <span>upper ${money(b.upper)}</span>
        </div>
      </div>`;
  }).join('');
}

function renderPlan(step) {
  if (step.actions.length === 0) {
    $('plan').innerHTML =
      '<div class="idle">Every balance sits inside its band. Nothing to do.</div>';
    return;
  }
  $('plan').innerHTML = step.actions.map((a) => `
    <div class="order">
      <span>
        <b style="color:${COLOR[a.currency]}">${a.currency}</b>
        ${a.amount > 0 ? 'buy' : 'release'}
      </span>
      <span class="num">${money(Math.abs(a.amount))} <span class="sub">· cost $${a.cost.toFixed(0)}</span></span>
    </div>`).join('');
}

function renderKpi(step, episode) {
  const gross = CURRENCIES.reduce((a, c) => a + Math.max(step.observed[c], 0), 0);
  $('kpi').innerHTML = `
    <div><span>ES 97.5% · 15 min</span><b class="num">${money(step.es)}</b></div>
    <div><span>Idle capital</span><b class="num">${money(gross)}</b></div>
    <div><span>Cumulative cost</span><b class="num">${money(step.cumulativeCost)}</b></div>
    <div><span>Breaches</span><b class="num" style="color:${episode.summary.breaches ? 'var(--bad)' : 'var(--ok)'}">${episode.summary.breaches}</b></div>`;
  $('kpinote').textContent =
    `${episode.summary.rebalances} rebalances this episode · bands solved in ${episode.computeMs} ms`;
}

function renderChart(episode, upto) {
  const W = 1000;
  const H = 200;
  const steps = episode.steps;
  const max = Math.max(...steps.flatMap((s) => CURRENCIES.map((c) => s.observed[c])), 1);

  const path = (c) => {
    const pts = steps.slice(0, upto + 1).map((s, i) => {
      const x = (i / Math.max(steps.length - 1, 1)) * W;
      const y = H - (Math.max(s.observed[c], 0) / max) * (H - 12) - 6;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return pts.length < 2 ? '' : `<polyline fill="none" stroke="${COLOR[c]}" stroke-width="1.6" points="${pts.join(' ')}"/>`;
  };

  const dayLines = [];
  const days = Math.ceil(steps.length / EPOCHS_PER_DAY);
  for (let d = 1; d < days; d++) {
    const x = ((d * EPOCHS_PER_DAY) / Math.max(steps.length - 1, 1)) * W;
    dayLines.push(`<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${H}" stroke="var(--line)" stroke-width="1"/>`);
  }

  const cursorX = ((upto / Math.max(steps.length - 1, 1)) * W).toFixed(1);
  const breaches = steps.slice(0, upto + 1)
    .map((s, i) => (s.breach ? `<circle cx="${((i / Math.max(steps.length - 1, 1)) * W).toFixed(1)}" cy="${H - 4}" r="3" fill="var(--bad)"/>` : ''))
    .join('');

  $('chart').innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="200" preserveAspectRatio="none">
      ${dayLines.join('')}
      ${CURRENCIES.map(path).join('')}
      ${breaches}
      <line x1="${cursorX}" y1="0" x2="${cursorX}" y2="${H}" stroke="var(--accent)" stroke-width="1" opacity=".7"/>
    </svg>
    <div class="ticks">
      ${CURRENCIES.map((c) => `<span style="color:${COLOR[c]}">${swatch(COLOR[c])}${c}</span>`).join('')}
      <span>peak ${money(max)}</span>
    </div>`;
}

function renderStep() {
  const ep = state.episode;
  if (!ep) return;
  const step = ep.steps[state.index];
  $('clock').textContent = clockLabel(step.t);
  renderCards(step, ep.bands);
  renderPlan(step);
  renderKpi(step, ep);
  renderChart(ep, state.index);
}

/* ------------------------------------------------------------------ */
/*                              Backtest                              */
/* ------------------------------------------------------------------ */

const POLICY_LABEL = {
  STATIC: 'Conservative pre-funding',
  CALENDAR: 'End-of-day rebalancing',
  FLOAT: 'FLOAT — optimised bands',
  CLAIRVOYANT: 'Calibrated on the realised window',
};

async function loadBacktest() {
  const res = await fetch('/api/backtest');
  if (!res.ok) {
    $('backtest').innerHTML =
      '<span class="sub">No results yet. Run <code>npm run backtest</code>.</span>';
    return;
  }
  const s = await res.json();
  const order = ['STATIC', 'CALENDAR', 'FLOAT', 'CLAIRVOYANT'];
  const maxCapital = Math.max(...order.map((k) => s.metrics[k].capital.mean));

  const rows = order.map((k) => {
    const m = s.metrics[k];
    const pctWidth = (m.capital.mean / maxCapital) * 100;
    const isFloat = k === 'FLOAT';
    return `
      <tr>
        <td>${POLICY_LABEL[k]}</td>
        <td style="width:34%">
          <svg viewBox="0 0 100 10" width="100%" height="12" preserveAspectRatio="none">
            <rect x="0" y="2" width="${pctWidth.toFixed(1)}" height="6"
                  fill="${isFloat ? 'var(--ok)' : 'var(--faint)'}" rx="1"/>
          </svg>
        </td>
        <td class="num">${money(m.capital.mean)} <span class="sub">± ${money(m.capital.halfWidth)}</span></td>
        <td class="num">${money(m.es.mean)}</td>
        <td class="num">${money(m.totalCost.mean)}</td>
        <td class="num">${Math.round(m.rebalances.mean)}</td>
      </tr>`;
  }).join('');

  const f = s.metrics.FLOAT;
  const st = s.metrics.STATIC;
  const drop = (a, b) => `${(((a - b) / b) * 100).toFixed(1)} %`;
  const e = s.estimationCost;

  $('backtest').innerHTML = `
    <div class="scroll-x"><table>
      <thead><tr><th>Policy</th><th></th><th>Idle capital</th><th>ES 97.5%</th><th>Total cost</th><th>Orders</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="kpi" style="margin-top:16px">
      <div><span>Idle capital</span><b class="num" style="color:var(--ok)">${drop(f.capital.mean, st.capital.mean)}</b></div>
      <div><span>ES 97.5%</span><b class="num" style="color:var(--ok)">${drop(f.es.mean, st.es.mean)}</b></div>
      <div><span>Total cost</span><b class="num">${drop(f.totalCost.mean, st.totalCost.mean)}</b></div>
      <div><span>Order count</span><b class="num" style="color:var(--warn)">+${Math.round(((f.rebalances.mean - st.rebalances.mean) / st.rebalances.mean) * 100)} %</b></div>
    </div>
    <div class="note">
      Execution cost falls <em>despite</em> thirty times more orders: under square-root
      market impact, many small orders cost less than a few large ones. That regime is only
      reachable because the fixed cost collapsed on the stablecoin rail.
      <br>
      Estimation error ${(e.mean * 100).toFixed(2)}% ± ${(e.halfWidth * 100).toFixed(2)}% —
      ${Math.abs(e.mean) < e.halfWidth
        ? 'the interval contains zero, so calibrating on the past costs nothing measurable.'
        : 'the interval excludes zero.'}
      The capital reduction holds from −84.9% to −84.2% across the full impact-sensitivity
      range; the cost reduction does not, and moves between −13% and −38%.
    </div>`;
}

/* ------------------------------------------------------------------ */
/*                             Interaction                            */
/* ------------------------------------------------------------------ */

const BREACH_STEPS = [1_000, 10_000, 50_000, 250_000, 1_000_000, 5_000_000, 25_000_000];

function currentParams(extra = {}) {
  return {
    kappa: Number($('kappa').value) / 100,
    eta: Number($('eta').value) / 10,
    breach: BREACH_STEPS[Number($('breach').value)],
    ...extra,
  };
}

/** Les commandes sont inertes pendant qu'un épisode se calcule : un clic sans effet
 *  laisse croire à une panne, un bouton grisé dit ce qui se passe. */
function setBusy(busy) {
  for (const id of ['play', 'step', 'shock']) $(id).disabled = busy;
}

async function loadEpisode(extra = {}) {
  if (state.loading) return;
  state.loading = true;
  setBusy(true);
  $('status').innerHTML = '<span class="spin">solving bands…</span>';
  const q = new URLSearchParams(currentParams(extra));
  try {
    const res = await fetch(`/api/episode?${q}`);
    state.episode = await res.json();
    state.index = 0;
    renderStep();
    $('status').textContent = `${state.episode.steps.length} epochs · ${state.episode.computeMs} ms`;
  } catch (err) {
    $('status').textContent = `failed: ${err.message}`;
  } finally {
    state.loading = false;
    setBusy(false);
  }
}

/**
 * Déclarer `prefers-reduced-motion` en CSS ne suffit pas : ce qui gêne ici n'est pas une
 * transition, c'est une lecture automatique qui redessine la page quatre fois par
 * seconde. On la refuse et on avance d'un pas, ce qui donne accès au même contenu.
 */
const prefersReducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

function stop() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  $('speedOut').textContent = speedLabel(Number($('speed').value));
label('play', 'play', 'Play');
}

/**
 * Un pas vaut quinze minutes simulées. Le curseur se lit donc en temps simulé par
 * seconde réelle, pas en pas par seconde : « deux heures par seconde » dit quelque chose,
 * « huit pas par seconde » ne dit rien.
 *
 * La valeur par défaut passe de vingt pas par seconde à quatre. À vingt, chaque carte
 * était redessinée toutes les cinquante millisecondes : l'œil ne suivait plus, et la
 * démonstration donnait à voir un scintillement plutôt qu'un mécanisme.
 */
const SIM_MINUTES_PER_STEP = 15;

function speedLabel(stepsPerSecond) {
  const minutes = stepsPerSecond * SIM_MINUTES_PER_STEP;
  return minutes < 60 ? `${minutes} min / s` : `${(minutes / 60).toFixed(minutes % 60 ? 1 : 0)} h / s`;
}

function play() {
  if (state.timer) return stop();
  if (prefersReducedMotion()) return advance();
  label('play', 'pause', 'Pause');
  const period = Math.max(1000 / Number($('speed').value), 60);
  state.timer = setInterval(() => {
    if (!state.episode || state.index >= state.episode.steps.length - 1) return stop();
    state.index++;
    renderStep();
  }, period);
}

function advance() {
  if (!state.episode || state.index >= state.episode.steps.length - 1) return;
  state.index++;
  renderStep();
}

$('play').addEventListener('click', play);
$('step').addEventListener('click', advance);
$('shock').addEventListener('click', () => {
  stop();
  // Le choc est injecté juste devant le curseur : la démonstration doit montrer la
  // réaction, pas la faire chercher.
  const at = Math.min((state.index ?? 0) + 2, (state.episode?.steps.length ?? 10) - 2);
  loadEpisode({ shockAt: at, shockCurrency: 'BRL', shockAmount: 2_500_000 }).then(() => {
    // On se place juste avant le choc pour qu'il soit visible, et non déjà corrigé.
    state.index = Math.max(at - 2, 0);
    renderStep();
    if (!prefersReducedMotion()) play();
  });
});
$('speed').addEventListener('input', () => {
  $('speedOut').textContent = speedLabel(Number($('speed').value));
  if (state.timer) {
    stop();
    play();
  }
});

for (const id of ['kappa', 'eta', 'breach']) {
  $(id).addEventListener('input', () => {
    $('kappaOut').textContent = (Number($('kappa').value) / 100).toFixed(2);
    $('etaOut').textContent = (Number($('eta').value) / 10).toFixed(1);
    $('breachOut').textContent = money(BREACH_STEPS[Number($('breach').value)]);
  });
  $(id).addEventListener('change', () => {
    stop();
    loadEpisode();
  });
}

$('speedOut').textContent = speedLabel(Number($('speed').value));
label('play', 'play', 'Play');
label('step', 'step', 'Step');
label('shock', 'bolt', 'Liquidity shock');

loadEpisode();
loadBacktest();
