/**
 * Calibration des corridors — SPEC §17.1 et §17.3.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AVERTISSEMENT D'HONNÊTETÉ
 * Ces valeurs sont des ordres de grandeur dérivés d'agrégats publics, pas des
 * mesures. Aucune institution ne publie ses flux par corridor. Chaque paramètre
 * porte son raisonnement et son niveau de confiance ; le README du dépôt reprend
 * cet avertissement à destination des juges.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Sources de raisonnement :
 *  - volumes et saisonnalité des paiements de détail en zone euro : statistiques
 *    de paiement de la BCE ;
 *  - tailles moyennes et déséquilibre directionnel des corridors de transfert de
 *    fonds : base « Remittance Prices Worldwide » de la Banque Mondiale ;
 *  - coût fixe du rail lent : grille de frais de virement international de
 *    correspondant bancaire, ordre de grandeur de plusieurs dizaines de dollars ;
 *  - coût fixe du rail rapide : gas libellé en USDC sur Arc, ordre de grandeur du cent.
 *
 * La quantité qui compte n'est pas la valeur absolue d'un paramètre mais le
 * **ratio des coûts fixes entre rails** (~10³–10⁴), qui pilote à lui seul
 * l'effondrement du buffer optimal démontré par le backtest.
 */

import type { CorridorSpec } from '../src/types.ts';

export const CORRIDORS: readonly CorridorSpec[] = [
  {
    id: 'EURUSD-FAST',
    base: 'EUR',
    quote: 'USD',
    rail: 'FAST',
    // Corridor principal, mélange de flux entreprises et particuliers.
    dailyVolumeUsd: 24_000_000,
    avgTicketUsd: 2_400,
    tailSigma: 1.35, // queue épaisse : quelques virements entreprises dominent le volume
    imbalance: 0.06, // quasi équilibré, léger biais sortant
    gammaFixedUsd: 0.02, // gas Arc en USDC
    latencySec: 0.35, // finalité mesurée d'Arc
    etaImpact: 0.35, // NON CALIBRÉ — paramètre exposé, sensibilité affichée
    maxDepthUsd: 5_000_000,
  },
  {
    id: 'GBPUSD-FAST',
    base: 'GBP',
    quote: 'USD',
    rail: 'FAST',
    dailyVolumeUsd: 9_000_000,
    avgTicketUsd: 1_900,
    tailSigma: 1.3,
    imbalance: -0.04,
    gammaFixedUsd: 0.02,
    latencySec: 0.35,
    etaImpact: 0.35,
    maxDepthUsd: 2_000_000,
  },
  {
    id: 'EURGBP-FAST',
    base: 'EUR',
    quote: 'GBP',
    rail: 'FAST',
    dailyVolumeUsd: 6_000_000,
    avgTicketUsd: 1_500,
    tailSigma: 1.25,
    imbalance: 0.02,
    gammaFixedUsd: 0.02,
    latencySec: 0.35,
    etaImpact: 0.35,
    maxDepthUsd: 1_500_000,
  },
  {
    /**
     * Le corridor « rail lent » de la posture hybride (décision D2).
     *
     * Aucun stablecoin BRL crédible n'existe : ce corridor se règle par correspondant
     * bancaire, avec un coût fixe trois ordres de grandeur au-dessus et une latence de
     * deux jours. Fortement déséquilibré, comme tout corridor de transfert de fonds :
     * les flux vont massivement dans un sens.
     *
     * C'est ce corridor qui rend le problème d'optimisation intéressant — sans lui,
     * tous les rails se valent et l'arbitrage disparaît.
     */
    id: 'EURBRL-SLOW',
    base: 'EUR',
    quote: 'BRL',
    rail: 'SLOW',
    dailyVolumeUsd: 3_000_000,
    avgTicketUsd: 420, // taille typique d'un transfert de fonds de particulier
    tailSigma: 1.15,
    imbalance: 0.55, // 77,5 % des paiements dans le sens EUR → BRL
    gammaFixedUsd: 25, // frais de virement de correspondant
    latencySec: 2 * 24 * 3600, // J+2
    etaImpact: 0,  // prix négocié de gré à gré, pas d'impact de carnet
    maxDepthUsd: Number.POSITIVE_INFINITY,
  },
];

export const CORRIDORS_BY_ID = new Map(CORRIDORS.map((c) => [c.id, c]));

/** Ratio des coûts fixes entre le rail lent et le rail rapide — la quantité structurante. */
export const GAMMA_RATIO =
  CORRIDORS.find((c) => c.rail === 'SLOW')!.gammaFixedUsd /
  CORRIDORS.find((c) => c.rail === 'FAST')!.gammaFixedUsd;
