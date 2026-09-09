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
      <rect x="0" y="7" width="100" height="8" fill="#0a0d12" rx="2"/>
      <rect x="0" y="7" width="${lo.toFixed(2)}" height="8" fill="#7f1d1d" opacity=".55"/>
      <rect x="${lo.toFixed(2)}" y="7" width="${Math.max(hi - lo, 0.4).toFixed(2)}" height="8" fill="#14532d" opacity=".8"/>
      <rect x="${hi.toFixed(2)}" y="7" width="${Math.max(100 - hi, 0).toFixed(2)}" height="8" fill="#78350f" opacity=".55"/>
      <line x1="${tgt.toFixed(2)}" y1="4" x2="${tgt.toFixed(2)}" y2="18" stroke="var(--dim)" stroke-width=".5" stroke-dasharray="1.5 1.5"/>
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
      ? '<span class="badge bad">rupture</span>'
      : acted
        ? '<span class="badge warn">rééquilibré</span>'
        : outside
          ? '<span class="badge warn">hors bande</span>'
          : '<span class="badge ok">dans la bande</span>';

    return `
      <div class="card ${bal < 0 ? 'hot' : ''}">
        <div class="ccy">
          <b style="color:${COLOR[c]}">${c}</b>
          ${badge}
        </div>
        <div class="bal num">${money(bal)}</div>
        <div class="sub num">flux de l'epoch ${signed(step.flows[c])}${
          acted ? ` · ramené à ${money(settled)}` : ''
        }</div>
        ${gauge(b, bal)}
        <div class="ticks num">
          <span>bas ${money(b.lower)}</span>
          <span>cible ${money(b.target)}</span>
          <span>haut ${money(b.upper)}</span>
        </div>
      </div>`;
  }).join('');
}

function renderPlan(step) {
  if (step.actions.length === 0) {
    $('plan').innerHTML =
      '<div class="idle">Tous les soldes sont à l’intérieur de leurs bandes — aucune action.</div>';
    return;
  }
  $('plan').innerHTML = step.actions.map((a) => `
    <div class="order">
      <span>
        <b style="color:${COLOR[a.currency]}">${a.currency}</b>
        ${a.amount > 0 ? 'acheter' : 'dégager'}
      </span>
      <span class="num">${money(Math.abs(a.amount))} <span class="sub">· coût ${a.cost.toFixed(0)} $</span></span>
    </div>`).join('');
}

function renderKpi(step, episode) {
  const gross = CURRENCIES.reduce((a, c) => a + Math.max(step.observed[c], 0), 0);
  $('kpi').innerHTML = `
    <div><span>ES 97,5 % · 15 min</span><b class="num">${money(step.es)}</b></div>
    <div><span>Capital immobilisé</span><b class="num">${money(gross)}</b></div>
    <div><span>Coût cumulé</span><b class="num">${money(step.cumulativeCost)}</b></div>
    <div><span>Ruptures</span><b class="num" style="color:${episode.summary.breaches ? 'var(--bad)' : 'var(--ok)'}">${episode.summary.breaches}</b></div>`;
  $('kpinote').textContent =
    `${episode.summary.rebalances} rééquilibrages sur l’épisode · bandes résolues en ${episode.computeMs} ms`;
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
      ${CURRENCIES.map((c) => `<span style="color:${COLOR[c]}">■ ${c}</span>`).join('')}
      <span>maximum ${money(max)}</span>
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
  STATIC: 'Pré-financement conservateur',
  CALENDAR: 'Rééquilibrage de fin de journée',
  FLOAT: 'FLOAT — bandes optimisées',
  CLAIRVOYANT: 'Calibré sur la période réalisée',
};

async function loadBacktest() {
  const res = await fetch('/api/backtest');
  if (!res.ok) {
    $('backtest').innerHTML =
      '<span class="sub">Aucun résultat. Lancer <code>npm run backtest</code>.</span>';
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
    <table>
      <thead><tr><th>Politique</th><th>Capital</th><th>Capital immobilisé</th><th>ES 97,5 %</th><th>Coût total</th><th>Ordres</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="kpi" style="margin-top:16px">
      <div><span>Capital immobilisé</span><b class="num" style="color:var(--ok)">${drop(f.capital.mean, st.capital.mean)}</b></div>
      <div><span>ES 97,5 %</span><b class="num" style="color:var(--ok)">${drop(f.es.mean, st.es.mean)}</b></div>
      <div><span>Coût total</span><b class="num">${drop(f.totalCost.mean, st.totalCost.mean)}</b></div>
      <div><span>Nombre d'ordres</span><b class="num" style="color:var(--warn)">+${Math.round(((f.rebalances.mean - st.rebalances.mean) / st.rebalances.mean) * 100)} %</b></div>
    </div>
    <div class="note">
      Le coût d'exécution baisse <em>malgré</em> trente fois plus d'ordres : sous impact en
      racine carrée, beaucoup de petits ordres coûtent moins que quelques gros. Ce régime
      n'est accessible que parce que le coût fixe s'est effondré sur le rail stablecoin.
      <br>
      Erreur d'estimation ${(e.mean * 100).toFixed(2)} % ± ${(e.halfWidth * 100).toFixed(2)} % —
      ${Math.abs(e.mean) < e.halfWidth
        ? 'l’intervalle contient zéro : calibrer sur le passé ne coûte rien de mesurable.'
        : 'l’intervalle exclut zéro.'}
      Réduction de capital stable de −84,9 % à −84,2 % sur toute la plage de sensibilité à
      l'impact ; la réduction de coût, elle, en dépend et va de −13 % à −38 %.
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

async function loadEpisode(extra = {}) {
  if (state.loading) return;
  state.loading = true;
  $('status').innerHTML = '<span class="spin">résolution des bandes…</span>';
  const q = new URLSearchParams(currentParams(extra));
  try {
    const res = await fetch(`/api/episode?${q}`);
    state.episode = await res.json();
    state.index = 0;
    renderStep();
    $('status').textContent = `${state.episode.steps.length} epochs · ${state.episode.computeMs} ms`;
  } catch (err) {
    $('status').textContent = `échec : ${err.message}`;
  } finally {
    state.loading = false;
  }
}

function stop() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  $('play').textContent = '▶ Lancer';
}

function play() {
  if (state.timer) return stop();
  $('play').textContent = '❚❚ Pause';
  const period = Math.max(1000 / Number($('speed').value), 16);
  state.timer = setInterval(() => {
    if (!state.episode || state.index >= state.episode.steps.length - 1) return stop();
    state.index++;
    renderStep();
  }, period);
}

$('play').addEventListener('click', play);
$('step').addEventListener('click', () => {
  if (state.episode && state.index < state.episode.steps.length - 1) {
    state.index++;
    renderStep();
  }
});
$('shock').addEventListener('click', () => {
  stop();
  // Le choc est injecté juste devant le curseur : la démonstration doit montrer la
  // réaction, pas la faire chercher.
  const at = Math.min((state.index ?? 0) + 2, (state.episode?.steps.length ?? 10) - 2);
  loadEpisode({ shockAt: at, shockCurrency: 'BRL', shockAmount: 2_500_000 }).then(() => {
    state.index = Math.max(at - 2, 0);
    renderStep();
    play();
  });
});
$('speed').addEventListener('input', () => {
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

loadEpisode();
loadBacktest();
