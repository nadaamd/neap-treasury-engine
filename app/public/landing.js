/**
 * Page d'accueil — les chiffres viennent du backtest, jamais du HTML.
 *
 * Le tableau et les barres sont alimentés par `/api/backtest`, c'est-à-dire par le
 * fichier que produit `npm run backtest`. Écrire ces valeurs à la main dans le balisage
 * aurait garanti qu'elles finissent périmées : un résultat qu'on recopie est un résultat
 * qu'on cesse de vérifier.
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
 * L'unique intention de mouvement de la page : la barre de NEAP part de la longueur du
 * pré-financement conservateur et tombe à la sienne. C'est la thèse, montrée plutôt
 * qu'affirmée — et jouée une seule fois, à l'arrivée en vue.
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
 * Repère de section dans le masthead.
 *
 * `IntersectionObserver` plutôt qu'un écouteur de défilement : le navigateur fait le
 * calcul hors du fil principal, et une barre collante qui saccade pendant qu'on scrolle
 * est pire que pas de repère du tout.
 *
 * La marge haute décale la zone de détection sous la barre : sans elle, une section
 * masquée par le masthead compterait comme visible.
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
 * Bascule la barre en mode compact dès que la page quitte le haut.
 *
 * Une sentinelle d'un pixel plutôt qu'une lecture de `scrollY` : le navigateur observe,
 * on ne calcule rien à chaque image, et le seuil ne peut pas osciller autour d'une
 * valeur limite quand l'utilisateur s'arrête pile dessus.
 */
function trackScrollState() {
  const bar = document.querySelector('.topbar');
  const sentinel = document.getElementById('top-sentinel');
  if (!bar || !sentinel) return;
  new IntersectionObserver(
    ([entry]) => bar.classList.toggle('compact', !entry.isIntersecting),
  ).observe(sentinel);
}

async function main() {
  trackSections();
  trackScrollState();

  let summary;
  try {
    const response = await fetch('/api/backtest');
    if (!response.ok) throw new Error(String(response.status));
    summary = await response.json();
  } catch {
    // Sans résultats, on le dit plutôt que d'afficher des chiffres inventés ou un vide.
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
