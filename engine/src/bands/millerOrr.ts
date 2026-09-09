/**
 * Solution analytique de Miller-Orr (1966) pour le contrôle d'un solde de trésorerie.
 *
 *   Z* = ∛( 3γσ² / 4r ) + L        H = 3Z* − 2L
 *
 * Hypothèses : flux nets browniens **sans dérive**, coût fixe γ par rééquilibrage, coût
 * de portage r par période, pas de risque de change, pas de coût de rupture.
 *
 * Ces hypothèses sont fausses dans notre cadre — un corridor de transfert de fonds est
 * structurellement déséquilibré, et le risque de change est justement ce qu'on cherche
 * à piloter. Miller-Orr n'est donc pas le modèle retenu (décision D3). Il sert à deux
 * choses, et elles comptent toutes les deux :
 *
 *   1. **amorcer** la recherche numérique, qui converge alors en quelques dizaines
 *      d'évaluations au lieu de quelques milliers ;
 *   2. **valider** cette recherche : sur le cas dégénéré sans dérive ni risque, le
 *      solveur numérique doit retrouver la formule fermée. C'est le test de
 *      non-régression du moteur de bandes.
 *
 * Propriété structurante du projet : la largeur de bande croît en γ^(1/3). Diviser le
 * coût fixe d'un rééquilibrage par 10⁴ — ce que fait le passage d'un rail de
 * correspondant bancaire à un règlement stablecoin — divise la bande par 10⁴^(1/3) ≈ 21,5.
 * C'est l'effondrement du buffer que le backtest doit chiffrer (SPEC §1.2).
 */

export interface Bands {
  /** Seuil bas : sous ce niveau, on réapprovisionne jusqu'à `target`. */
  readonly lower: number;
  /** Cible de retour après rééquilibrage. */
  readonly target: number;
  /** Seuil haut : au-dessus, on dégage l'excédent jusqu'à `target`. */
  readonly upper: number;
}

export interface MillerOrrInput {
  /** Coût fixe d'un rééquilibrage, en monnaie. */
  readonly gammaFixed: number;
  /** Écart-type du flux net par période. */
  readonly flowSigma: number;
  /** Coût de portage par période (taux, pas pourcentage). */
  readonly carryRate: number;
  /** Plancher opérationnel ou réglementaire. */
  readonly lower: number;
}

export function millerOrrBands(input: MillerOrrInput): Bands {
  const { gammaFixed, flowSigma, carryRate, lower } = input;
  if (carryRate <= 0) throw new RangeError('le coût de portage doit être strictement positif');
  if (flowSigma <= 0) throw new RangeError('la volatilité des flux doit être strictement positive');

  const spread = Math.cbrt((3 * gammaFixed * flowSigma * flowSigma) / (4 * carryRate));
  const target = lower + spread;
  return { lower, target, upper: 3 * target - 2 * lower };
}
