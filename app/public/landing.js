/**
 * Page d'accueil — les chiffres viennent du backtest, jamais du HTML.
 *
 * Le tableau et les barres sont alimentés par `/api/backtest`, c'est-à-dire par le
 * fichier que produit `npm run backtest`. Écrire ces valeurs à la main dans le balisage
 * aurait garanti qu'elles finissent périmées : un résultat qu'on recopie est un résultat
 * qu'on cesse de vérifier.
 */

const ORDER = ['STATIC', 'CALENDAR', 'FLOAT', 'CLAIRVOYANT'];

const LABEL = {
  STATIC: 'Conservative pre-funding',
  CALENDAR: 'End-of-day rebalancing',
  FLOAT: 'FLOAT — optimised bands',
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
 * L'unique intention de mouvement de la page : la barre de FLOAT part de la longueur du
 * pré-financement conservateur et tombe à la sienne. C'est la thèse, montrée plutôt
 * qu'affirmée — et jouée une seule fois, à l'arrivée en vue.
 */
function drawCollapse(staticCapital, floatCapital, halfWidth) {
  const max = staticCapital;
  const ratio = floatCapital / max;

  document.getElementById('v-static').textContent = money(staticCapital);
  document.getElementById('v-float').textContent = money(floatCapital);
  document.getElementById('ci-float').textContent = `± ${money(halfWidth)}`;

  const ref = document.getElementById('b-static');
  const now = document.getElementById('b-float');
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
    const hero = key === 'FLOAT' ? ' class="hero"' : '';
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

async function main() {
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
    document.getElementById('v-float').textContent = '—';
    return;
  }

  const m = summary.metrics;
  drawCollapse(m.STATIC.capital.mean, m.FLOAT.capital.mean, m.FLOAT.capital.halfWidth);
  drawTable(m);

  document.title = `FLOAT — idle capital ${pct(m.FLOAT.capital.mean, m.STATIC.capital.mean)}`;
}

main();
