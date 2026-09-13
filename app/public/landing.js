/**
 * Landing page — the numbers come from the backtest, never from the HTML.
 *
 * The table and the bars are fed by `/api/backtest`, that is, by the file `npm run
 * backtest` produces. Writing those values by hand into the markup would have guaranteed
 * they end up stale: a result you copy is a result you stop checking.
 */

const ORDER = ['STATIC', 'CALENDAR', 'NEAP', 'CLAIRVOYANT'];

const LABEL = {
  STATIC: 'Conservative pre-funding',
  CALENDAR: 'End-of-day rebalancing',
  NEAP: 'NEAP — optimised bands',
  CLAIRVOYANT: 'Calibrated on the realised window',
};

const money = (x) => {
  const a = Math.abs(x);
  if (a >= 1e6) return `$${(x / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${Math.round(x / 1e3)}k`;
  return `$${Math.round(x)}`;
};

const pct = (a, b) => `${(((a - b) / b) * 100).toFixed(1)}%`;

/**
 * The page's single intention of movement: NEAP's bar starts at the length of
 * conservative pre-funding and collapses to its own. That is the thesis, shown rather
 * than asserted — and played once, on entering view.
 */
function drawCollapse(staticCapital, neapCapital, halfWidth) {
  const max = staticCapital;
  const ratio = neapCapital / max;

  document.getElementById('v-static').textContent = money(staticCapital);
  document.getElementById('v-neap').textContent = money(neapCapital);
  document.getElementById('ci-neap').textContent = `± ${money(halfWidth)}`;

  const ref = document.getElementById('b-static');
  const now = document.getElementById('b-neap');
  ref.style.transform = 'scaleX(1)';

  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  if (reduced) {
    now.style.transform = `scaleX(${ratio})`;
    return;
  }

  now.style.setProperty('--from', '1');
  now.style.setProperty('--to', String(ratio));
  now.style.transform = `scaleX(${ratio})`;

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        now.classList.add('play');
        observer.disconnect();
      }
    },
    { threshold: 0.4 },
  );
  observer.observe(document.getElementById('collapse'));
}

function drawTable(metrics) {
  const body = document.getElementById('results-body');
  body.innerHTML = ORDER.map((key) => {
    const m = metrics[key];
    const hero = key === 'NEAP' ? ' class="hero"' : '';
    return `
      <tr${hero}>
        <td>${LABEL[key]}</td>
        <td class="num">${money(m.capital.mean)}</td>
        <td class="num">${money(m.es.mean)}</td>
        <td class="num">${money(m.totalCost.mean)}</td>
        <td class="num">${Math.round(m.rebalances.mean).toLocaleString('en-US')}</td>
        <td class="num">${m.breaches.mean.toFixed(2)}</td>
      </tr>`;
  }).join('');
}

/**
 * Section marker in the masthead.
 *
 * `IntersectionObserver` rather than a scroll listener: the browser does the work off the
 * main thread, and a sticky bar that stutters while you scroll is worse than no marker at
 * all.
 *
 * The top margin shifts the detection zone below the bar: without it, a section hidden
 * behind the masthead would count as visible.
 */
function trackSections() {
  const links = new Map();
  for (const a of document.querySelectorAll(".topbar nav a[href^='#']")) {
    links.set(a.getAttribute('href').slice(1), a);
  }
  const visible = new Set();

  const mark = () => {
    let current = null;
    for (const id of links.keys()) if (visible.has(id)) { current = id; break; }
    for (const [id, a] of links) {
      if (id === current) a.setAttribute('aria-current', 'true');
      else a.removeAttribute('aria-current');
    }
  };

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target.id);
        else visible.delete(entry.target.id);
      }
      mark();
    },
    { rootMargin: '-64px 0px -55% 0px' },
  );

  for (const id of links.keys()) {
    const section = document.getElementById(id);
    if (section) observer.observe(section);
  }
}

/**
 * Switches the bar to compact mode as soon as the page leaves the top.
 *
 * A one-pixel sentinel rather than reading `scrollY`: the browser observes, nothing is
 * computed per frame, and the threshold cannot oscillate around a boundary value when the
 * user stops exactly on it.
 */
function trackScrollState() {
  const bar = document.querySelector('.topbar');
  const sentinel = document.getElementById('top-sentinel');
  if (!bar || !sentinel) return;
  new IntersectionObserver(
    ([entry]) => bar.classList.toggle('compact', !entry.isIntersecting),
  ).observe(sentinel);
}

/**
 * Light parallax on the phone.
 *
 * The animated drift is enough to make it feel alive; this tracking adds the sense that
 * it occupies a space in front of the page rather than on it. Only a CSS variable is
 * written, read inside a rotation: the drift keeps turning uninterrupted, and nothing but
 * the compositor does any work.
 *
 * Ignored on a coarse pointer — a finger has no hover position — and under a
 * reduced-motion preference.
 */
function trackPointer() {
  const phone = document.querySelector('.phone');
  if (!phone) return;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  if (reduced || coarse) return;

  let queued = false;
  let x = 0;
  let y = 0;

  const apply = () => {
    queued = false;
    phone.style.setProperty('--tilt-y', `${x.toFixed(2)}deg`);
    phone.style.setProperty('--tilt-x', `${y.toFixed(2)}deg`);
  };

  addEventListener('pointermove', (event) => {
    x = (event.clientX / innerWidth - 0.5) * 7;
    y = (0.5 - event.clientY / innerHeight) * 5;
    if (!queued) {
      queued = true;
      requestAnimationFrame(apply);
    }
  }, { passive: true });
}

async function main() {
  trackSections();
  trackScrollState();
  trackPointer();

  let summary;
  try {
    const response = await fetch('/api/backtest');
    if (!response.ok) throw new Error(String(response.status));
    summary = await response.json();
  } catch {
    // With no results, say so rather than showing invented numbers or a blank.
    document.getElementById('results-body').innerHTML =
      '<tr><td colspan="6" class="fine">No backtest on this host. Run <code>npm run backtest</code> to regenerate it.</td></tr>';
    document.getElementById('v-static').textContent = '—';
    document.getElementById('v-neap').textContent = '—';
    return;
  }

  const m = summary.metrics;
  drawCollapse(m.STATIC.capital.mean, m.NEAP.capital.mean, m.NEAP.capital.halfWidth);
  drawTable(m);

  document.title = `NEAP — idle capital ${pct(m.NEAP.capital.mean, m.STATIC.capital.mean)}`;
}

main();
