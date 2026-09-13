/**
 * NEAP dashboard — animating an episode computed by the server.
 *
 * No business logic here: the bands, the decisions, the risk and the costs all come from
 * the engine. The client animates, it does not decide — otherwise the demo would show an
 * approximate reimplementation rather than the system itself.
 */

const CURRENCIES = ['EUR', 'GBP', 'BRL'];
const COLOR = { EUR: 'var(--eur)', GBP: 'var(--gbp)', BRL: 'var(--brl)' };
const EPOCHS_PER_DAY = 96;

const state = {
  episode: null,
  index: 0,
  timer: null,
  loading: false,
  /** Most recent orders, newest first. */
};

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ */
/*                               Icons                                */
/* ------------------------------------------------------------------ */

/**
 * Drawn glyphs, single-stroke — solid silhouettes on a 16-unit grid.
 *
 * The Unicode characters previously used as icons (▶, ❚❚, ⚡, ■) took the system font:
 * every platform rendered a different variant, with its own width and optical alignment.
 * A drawn set depends on nothing.
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
/*                            Band gauge                              */
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
/*                               Render                               */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*                   Render: build once, then update                  */
/* ------------------------------------------------------------------ */

/**
 * Rendering builds the structure once, then writes only values.
 *
 * The previous version rewrote `innerHTML` on every epoch. Four times a second the
 * browser threw away and rebuilt every card, every gauge and every log row: the cards
 * flickered, the layout shivered, and the latest-order animation retriggered on all rows
 * since all of them were new.
 *
 * Here nodes are created once and only values change. Nothing flickers, the animation
 * plays only on the genuinely new row, and the per-step cost becomes negligible.
 */
const nodes = { cards: new Map(), chart: null, log: null };

function buildCards(bands) {
  const host = $('cards');
  host.innerHTML = '';
  nodes.cards.clear();

  for (const c of CURRENCIES) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="ccy">
        <b style="color:${COLOR[c]}">${c}</b>
        <span class="badge ok" data-badge>in band</span>
      </div>
      <div class="bal num" data-bal>—</div>
      <div class="sub num" data-flow>&nbsp;</div>
      <svg class="gauge" viewBox="0 0 100 22" width="100%" height="34" preserveAspectRatio="none">
        <rect x="0" y="7" width="100" height="8" fill="var(--panel-2)" rx="2"/>
        <rect y="7" height="8" fill="var(--zone-low)" data-low/>
        <rect y="7" height="8" fill="var(--zone-ok)" data-ok/>
        <rect y="7" height="8" fill="var(--zone-high)" data-high/>
        <line y1="4" y2="18" stroke="var(--dim)" stroke-width=".6" stroke-dasharray="1.5 1.5" data-target/>
        <rect y="2" width="1.1" height="18" data-marker/>
      </svg>
      <div class="ticks num">
        <span>lower ${money(bands[c].lower)}</span>
        <span>target ${money(bands[c].target)}</span>
        <span>upper ${money(bands[c].upper)}</span>
      </div>`;
    host.append(card);
    nodes.cards.set(c, {
      card,
      badge: card.querySelector('[data-badge]'),
      bal: card.querySelector('[data-bal]'),
      flow: card.querySelector('[data-flow]'),
      low: card.querySelector('[data-low]'),
      ok: card.querySelector('[data-ok]'),
      high: card.querySelector('[data-high]'),
      target: card.querySelector('[data-target]'),
      marker: card.querySelector('[data-marker]'),
    });
  }
}

function updateCards(step, bands) {
  for (const c of CURRENCIES) {
    const n = nodes.cards.get(c);
    const b = bands[c];
    const bal = step.observed[c];
    const settled = step.balances[c];
    const outside = bal < b.lower || bal > b.upper;
    const acted = step.actions.some((a) => a.currency === c);

    n.card.classList.toggle('hot', bal < 0);
    n.bal.textContent = money(bal);
    n.flow.textContent = `epoch flow ${signed(step.flows[c])}${acted ? ` · pulled back to ${money(settled)}` : ''}`;

    const [cls, label] = bal < 0
      ? ['badge bad', 'breach']
      : acted ? ['badge warn', 'rebalanced']
      : outside ? ['badge warn', 'outside band']
      : ['badge ok', 'in band'];
    if (n.badge.className !== cls) n.badge.className = cls;
    if (n.badge.textContent !== label) n.badge.textContent = label;

    const span = Math.max(b.upper * 1.35, bal * 1.15, 1);
    const x = (v) => Math.max(0, Math.min(100, (v / span) * 100));
    const lo = x(b.lower);
    const hi = x(b.upper);
    const pos = x(bal);

    n.low.setAttribute('x', '0');
    n.low.setAttribute('width', lo.toFixed(2));
    n.ok.setAttribute('x', lo.toFixed(2));
    n.ok.setAttribute('width', Math.max(hi - lo, 0.4).toFixed(2));
    n.high.setAttribute('x', hi.toFixed(2));
    n.high.setAttribute('width', Math.max(100 - hi, 0).toFixed(2));
    const tgt = x(b.target).toFixed(2);
    n.target.setAttribute('x1', tgt);
    n.target.setAttribute('x2', tgt);
    n.marker.setAttribute('x', Math.max(pos - 0.55, 0).toFixed(2));
    n.marker.setAttribute('fill', outside ? 'var(--bad)' : 'var(--ok)');
  }
}

/* ------------------------------------------------------------------ */

const LOG_LENGTH = 6;

function buildLog() {
  $('plan').innerHTML = '<div class="idle">Every balance sits inside its band. Nothing to do yet.</div>';
  nodes.log = null;
}

/**
 * The log only prepends genuinely new rows.
 *
 * Rebuilding it wholesale restarted the highlight animation on all six rows every epoch:
 * the whole panel flashed yellow, and the marker lost exactly what it was there to
 * provide.
 */
function appendToLog(step) {
  if (step.actions.length === 0) return;

  if (!nodes.log) {
    $('plan').innerHTML = '';
    nodes.log = document.createElement('div');
    $('plan').append(nodes.log);
  }

  for (const a of step.actions) {
    const row = document.createElement('div');
    row.className = 'order fresh';
    row.innerHTML = `
      <span class="at">${clockLabel(step.t).split('  ')[1] ?? ''}</span>
      <span><b style="color:${COLOR[a.currency]}">${a.currency}</b> ${a.amount > 0 ? 'buy' : 'release'}</span>
      <span class="num">${money(Math.abs(a.amount))} <span class="sub">· $${a.cost.toFixed(0)}</span></span>`;
    nodes.log.prepend(row);
  }
  while (nodes.log.children.length > LOG_LENGTH) nodes.log.lastElementChild.remove();
}

/* ------------------------------------------------------------------ */

function buildKpi() {
  $('kpi').innerHTML = `
    <div><span>ES 97.5% · 15 min</span><b class="num" data-es>—</b></div>
    <div><span>Idle capital</span><b class="num" data-cap>—</b></div>
    <div><span>Cumulative cost</span><b class="num" data-cost>—</b></div>
    <div><span>Breaches</span><b class="num" data-breach>—</b></div>`;
}

function updateKpi(step, episode) {
  const gross = CURRENCIES.reduce((a, c) => a + Math.max(step.observed[c], 0), 0);
  $('kpi').querySelector('[data-es]').textContent = money(step.es);
  $('kpi').querySelector('[data-cap]').textContent = money(gross);
  $('kpi').querySelector('[data-cost]').textContent = money(step.cumulativeCost);
  const breach = $('kpi').querySelector('[data-breach]');
  breach.textContent = String(episode.summary.breaches);
  breach.style.color = episode.summary.breaches ? 'var(--bad)' : 'var(--ok)';
  $('kpinote').textContent =
    `${episode.summary.rebalances} rebalances this episode · bands solved in ${episode.computeMs} ms`;
}

/* ------------------------------------------------------------------ */

function buildChart(episode) {
  const W = 1000;
  const H = 200;
  const steps = episode.steps;
  const max = Math.max(...steps.flatMap((s) => CURRENCIES.map((c) => s.observed[c])), 1);

  const dayLines = [];
  const days = Math.ceil(steps.length / EPOCHS_PER_DAY);
  for (let d = 1; d < days; d++) {
    const x = ((d * EPOCHS_PER_DAY) / Math.max(steps.length - 1, 1)) * W;
    dayLines.push(`<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${H}" stroke="var(--line)" stroke-width="1"/>`);
  }

  $('chart').innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="none">
      ${dayLines.join('')}
      ${CURRENCIES.map((c) => `<polyline fill="none" stroke="${COLOR[c]}" stroke-width="1.6" data-line="${c}"/>`).join('')}
      <g data-breaches></g>
      <line y1="0" y2="${H}" stroke="var(--accent)" stroke-width="1" opacity=".7" data-cursor/>
    </svg>
    <div class="ticks">
      ${CURRENCIES.map((c) => `<span style="color:${COLOR[c]}">${swatch(COLOR[c])}${c}</span>`).join('')}
      <span>peak ${money(max)}</span>
    </div>`;

  nodes.chart = {
    W, H, max,
    lines: Object.fromEntries(CURRENCIES.map((c) => [c, $('chart').querySelector(`[data-line="${c}"]`)])),
    breaches: $('chart').querySelector('[data-breaches]'),
    cursor: $('chart').querySelector('[data-cursor]'),
  };
}

function updateChart(episode, upto) {
  const { W, H, max, lines, breaches, cursor } = nodes.chart;
  const steps = episode.steps;
  const span = Math.max(steps.length - 1, 1);

  for (const c of CURRENCIES) {
    const pts = [];
    for (let i = 0; i <= upto; i++) {
      const x = (i / span) * W;
      const y = H - (Math.max(steps[i].observed[c], 0) / max) * (H - 12) - 6;
      pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }
    lines[c].setAttribute('points', pts.length < 2 ? '' : pts.join(' '));
  }

  const marks = [];
  for (let i = 0; i <= upto; i++) {
    if (steps[i].breach) marks.push(`<circle cx="${((i / span) * W).toFixed(1)}" cy="${H - 4}" r="3" fill="var(--bad)"/>`);
  }
  if (breaches.innerHTML !== marks.join('')) breaches.innerHTML = marks.join('');

  const cx = ((upto / span) * W).toFixed(1);
  cursor.setAttribute('x1', cx);
  cursor.setAttribute('x2', cx);
}

/** Rebuilds the structure: once per episode, never during playback. */
function buildEpisodeView(episode) {
  buildCards(episode.bands);
  buildLog();
  buildKpi();
  buildChart(episode);
}

function renderStep(withLog = true) {
  const ep = state.episode;
  if (!ep) return;
  const step = ep.steps[state.index];
  $('clock').textContent = clockLabel(step.t);
  updateCards(step, ep.bands);
  if (withLog) appendToLog(step);
  updateKpi(step, ep);
  updateChart(ep, state.index);
}

/* ------------------------------------------------------------------ */
/*                              Backtest                              */
/* ------------------------------------------------------------------ */

const POLICY_LABEL = {
  STATIC: 'Conservative pre-funding',
  CALENDAR: 'End-of-day rebalancing',
  NEAP: 'NEAP — optimised bands',
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
  const order = ['STATIC', 'CALENDAR', 'NEAP', 'CLAIRVOYANT'];
  const maxCapital = Math.max(...order.map((k) => s.metrics[k].capital.mean));

  const rows = order.map((k) => {
    const m = s.metrics[k];
    const pctWidth = (m.capital.mean / maxCapital) * 100;
    const isFloat = k === 'NEAP';
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

  const f = s.metrics.NEAP;
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

/** The controls are inert while an episode is solving: a click with no effect looks
 *  like a failure, a greyed-out button says what is happening. */
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
    buildEpisodeView(state.episode);
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
 * Declaring `prefers-reduced-motion` in CSS is not enough: what bothers people here is
 * not a transition, it is autoplay redrawing the page four times a second. We decline it
 * and step forward once instead, which gives access to the same content.
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
 * One step is fifteen simulated minutes. The slider therefore reads in simulated time per
 * real second, not in steps per second: "two hours per second" says something, "eight
 * steps per second" says nothing.
 *
 * The default moves from twenty steps per second to four. At twenty, each card was
 * redrawn every fifty milliseconds: the eye could not follow, and the demo showed a
 * flicker rather than a mechanism.
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
  // The shock is injected just ahead of the cursor: the demo should show the reaction,
  // not make you hunt for it.
  const at = Math.min((state.index ?? 0) + 2, (state.episode?.steps.length ?? 10) - 2);
  loadEpisode({ shockAt: at, shockCurrency: 'BRL', shockAmount: 2_500_000 }).then(() => {
    // Position just before the shock so it is visible, rather than already corrected.
    state.index = Math.max(at - 2, 0);
    renderStep(false);
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
