/** Types du domaine « flux de paiement ». Voir SPEC §15.1. */

export type Currency = 'USD' | 'EUR' | 'GBP' | 'BRL';

/**
 * Régime de coût du corridor.
 *
 * FAST : règlement stablecoin sur Arc — coût fixe de l'ordre du cent, finalité sub-seconde.
 * SLOW : rail de correspondant bancaire — coût fixe de plusieurs dizaines de dollars, J+1/J+2.
 *
 * Le ratio des coûts fixes entre les deux régimes est la seule quantité vraiment
 * structurante du modèle (SPEC §17.3) : c'est lui qui produit l'effondrement du buffer.
 */
export type Rail = 'FAST' | 'SLOW';

export interface CorridorSpec {
  readonly id: string;
  /** Devise reçue lorsque le corridor est emprunté dans le sens base → quote. */
  readonly base: Currency;
  /** Devise payée dans ce même sens. */
  readonly quote: Currency;
  readonly rail: Rail;
  /** Volume quotidien, en équivalent USD. */
  readonly dailyVolumeUsd: number;
  /** Taille moyenne d'un paiement, en équivalent USD. */
  readonly avgTicketUsd: number;
  /** Paramètre de forme de la log-normale des montants : plus il est grand, plus la queue est épaisse. */
  readonly tailSigma: number;
  /**
   * Déséquilibre directionnel ∈ [-1, 1].
   * 0 = corridor équilibré ; +0.5 = 75 % des paiements vont de base vers quote.
   * C'est ce terme qui crée le drift, et donc qui invalide les bandes symétriques
   * de Miller-Orr (SPEC §4.2).
   */
  readonly imbalance: number;
  /** Coût fixe d'un rééquilibrage sur ce rail, en USD. */
  readonly gammaFixedUsd: number;
  /** Latence de règlement, en secondes. */
  readonly latencySec: number;
  /** Coefficient d'impact de marché — non calibrable (SPEC §4.6), exposé en paramètre. */
  readonly etaImpact: number;
  /** Profondeur exploitable indicative, en USD. */
  readonly maxDepthUsd: number;
}

export interface FlowEvent {
  /** Horodatage, ms depuis epoch. */
  readonly ts: number;
  readonly corridorId: string;
  /** Devise dont le solde augmente. */
  readonly receive: Currency;
  /** Devise dont le solde diminue. */
  readonly pay: Currency;
  /**
   * Montant en équivalent USD.
   * La conversion vers les unités natives de chaque devise se fait dans la couche moteur,
   * qui dispose des taux ; le générateur reste agnostique au marché.
   */
  readonly notionalUsd: number;
}

export type NetByCurrency = Record<Currency, number>;

export interface FlowBucket {
  readonly startTs: number;
  readonly net: NetByCurrency;
  readonly count: number;
}
