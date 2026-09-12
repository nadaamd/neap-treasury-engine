# Backtest walk-forward — résultats de référence

> Généré par `node engine/scripts/backtest.ts`, 20 germes × 6 fenêtres, 523 s.
> Reproductible : les germes sont fixés, aucune source d'aléa non amorcée dans le dépôt.

```

════════════════════════════════════════════════════════════════════════════════════════════════
  NEAP — backtest walk-forward · 20 germes × 6 fenêtres
════════════════════════════════════════════════════════════════════════════════════════════════

  Moyennes par fenêtre d'évaluation, avec intervalle de confiance à 95 %.

  Politique                                      │  Capital immobilisé  │  ES 97,5 %           │  Coût total          │  Exécution  │  Ruptures  │  Rééquil.
  ───────────────────────────────────────────────┼──────────────────────┼──────────────────────┼──────────────────────┼─────────────┼────────────┼──────────
  STATIC      (pré-financement conservateur)     │  1.74 M$ ± 109.7 k$  │  77.8 k$ ± 8.0 k$    │  356.2 k$ ± 10.8 k$  │  330.4 k$   │  0.03      │  90      
  CALENDAR    (rééquilibrage de fin de journée)  │  2.27 M$ ± 66.9 k$   │  114.6 k$ ± 12.9 k$  │  419.8 k$ ± 2.7 k$   │  386.2 k$   │  3.24      │  90      
  NEAP       (bandes optimisées, par signal)    │  269.3 k$ ± 3.6 k$   │  8.2 k$ ± 876.8 $    │  269.3 k$ ± 1.5 k$   │  265.3 k$   │  1.36      │  2879    
  CLAIRVOYANT (calibré sur la période réalisée)  │  270.0 k$ ± 3.8 k$   │  8.2 k$ ± 852.8 $    │  269.1 k$ ± 1.6 k$   │  265.1 k$   │  1.38      │  2875    

  Écarts de NEAP par rapport au pré-financement conservateur :

    capital immobilisé   -84.6 %
    ES 97,5 %            -89.4 %
    coût total           -24.4 %
    coût d'exécution     -19.7 %
    nombre d'ordres      +3113.2 %

  Coût de l'incertitude d'estimation
  ────────────────────────────────────────────────────────────────────────────────────────────
    NEAP contre calibration sur la période réalisée : 0.05 % ± 0.19 %
    L'intervalle contient zéro : calibrer sur le passé ne coûte rien de mesurable ici.

  Lecture
  ────────────────────────────────────────────────────────────────────────────────────────────
    Le capital immobilisé et le risque de change s'effondrent, le coût total baisse
    plus modestement. Ce n'est pas une contradiction : à 6 % par an, le portage d'un
    million de dollars sur une fenêtre de quelques semaines pèse peu face aux coûts
    d'exécution. La valeur du capital libéré ne se lit pas dans le coût de portage,
    elle se lit dans le capital lui-même.

    Le coût d'exécution baisse *malgré* un nombre d'ordres bien supérieur, et c'est le
    mécanisme central : sous impact en racine carrée, beaucoup de petits ordres coûtent
    moins cher que quelques gros. Ce régime n'est accessible que parce que le coût fixe
    d'un rééquilibrage s'est effondré sur le rail stablecoin — sur un rail de
    correspondant bancaire, mille trois cents ordres coûteraient à eux seuls plus que
    tout le reste.

    NEAP tolère davantage de ruptures que le pré-financement conservateur, et c'est
    l'optimiseur qui fait son travail : le coût de rupture retenu est de 50 000 $, et à
    l'optimum la probabilité de rupture varie en 1/c_b. Une institution qui valorise
    davantage une rupture de paiement obtient mécaniquement un buffer plus épais.

  Hypothèses — à lire avant les chiffres
  ────────────────────────────────────────────────────────────────────────────────────────────
    Flux de paiement       synthétiques, Poisson composé calibré sur agrégats publics
    Marché de change       GARCH(1,1) à innovations de Student, germe indépendant des flux
    Coût du capital        6.0 % par an
    Impact de marché       NON CALIBRÉ — eta = 0.002 sur l'euro
                           (coût relatif d'un ordre consommant toute la profondeur)
    Rail lent              BRL, coût fixe 25 $, règlement J+2
    Calibration            fenêtre extensible, 90 jours d'amorçage
    Évaluation             30 jours par fenêtre, jamais vus à la calibration

  Sensibilité au coefficient d'impact — le seul paramètre inventé du modèle
  ────────────────────────────────────────────────────────────────────────────────────────────
    eta × 0.5   capital  -84.9 %   coût total  -13.0 %
    eta × 1.0   capital  -84.6 %   coût total  -24.4 %
    eta × 2.0   capital  -84.2 %   coût total  -38.0 %

  Durée : 523.7 s

  Résultats écrits dans results/backtest.json
```

## Ce que ces chiffres disent, et ce qu'ils ne disent pas

### Le résultat robuste : le capital

La réduction du capital immobilisé — **−84,6 %** — est stable sur toute la plage de
sensibilité testée : −84,9 % à `eta × 0,5`, −84,2 % à `eta × 2`. Elle ne dépend donc
pas du seul paramètre non calibré du modèle. C'est le chiffre sur lequel s'appuyer.

L'intervalle de confiance est serré (± 3,6 k$ sur 269 k$, soit ± 1,3 %) parce que la
politique optimisée converge vers la même cible quel que soit le germe : le buffer
optimal est une propriété de la structure des flux, pas un accident d'échantillon.

### Le résultat conditionnel : le coût total

La baisse du coût total — **−24,4 %** — varie de −13 % à −38 % selon le coefficient
d'impact. Elle est donc **conditionnelle à une hypothèse invérifiable en l'état**. Toute
présentation de ce chiffre doit s'accompagner de sa plage de sensibilité ; le publier
seul serait trompeur.

### Le mécanisme, qui n'est pas celui qu'on attendait

L'intuition de départ était « le buffer s'effondre, donc le portage baisse ». Le portage
baisse en effet, mais il ne pesait presque rien : à 6 % par an, immobiliser un million
de dollars sur une fenêtre de trente jours coûte quelques milliers de dollars, contre
plusieurs centaines de milliers de coûts d'exécution.

Le gain vient d'ailleurs. Le coût d'exécution baisse de **19,7 % malgré trente fois plus
d'ordres**. Sous un impact de marché en racine carrée, découper un rééquilibrage en
nombreux petits ordres coûte structurellement moins cher que de l'exécuter en quelques
gros blocs. Ce régime n'est accessible que parce que le coût fixe d'un rééquilibrage
s'est effondré : sur un rail de correspondant bancaire à 25 $ l'ordre, deux mille huit
cents ordres coûteraient à eux seuls sept fois le budget total.

**La finalité sub-seconde et le gaz à quelques cents ne rendent pas le rééquilibrage
« moins cher » à la marge. Ils rendent accessible un régime d'exécution entièrement
différent.**

### L'erreur d'estimation n'est pas le facteur limitant

`0,05 % ± 0,19 %` : l'écart entre calibrer sur le passé et calibrer sur la période
réalisée contient zéro. Autrement dit, une politique qui aurait connu la distribution
de la période à venir n'aurait pas fait mieux. La structure des flux est assez stable
pour que le walk-forward ne coûte rien.

Sur un échantillon réduit à deux germes, cette même grandeur valait −1,87 % ± 0,77 % —
un écart apparemment significatif, en réalité du bruit. C'est l'argument pour les vingt
germes et les intervalles de confiance : un seul run aurait produit un chiffre faux avec
l'apparence de la précision.

### Ce qui est moins bon, et qu'il faut dire

**NEAP tolère plus de ruptures que le pré-financement conservateur** : 1,36 contre 0,03
par fenêtre. Ce n'est pas un défaut d'implémentation, c'est l'optimiseur qui applique le
coût de rupture qu'on lui a donné (50 000 $). À l'optimum, la probabilité de rupture
varie en `1/c_b` — une institution qui valorise davantage un incident de paiement obtient
mécaniquement un buffer plus épais. Le paramètre est exposé et son effet est démontré en
test unitaire.

À noter que la politique calendaire fait pire encore (3,24 ruptures) : ne regarder
l'état qu'une fois par jour laisse le solde dériver sans surveillance entre deux
contrôles.

### Limites connues

- Les flux de paiement sont **synthétiques**. Aucune institution ne publie ses flux par
  corridor ; le générateur est calibré sur des agrégats publics et ses propriétés
  statistiques sont testées, mais ce ne sont pas des données réelles.
- Le coefficient d'impact n'est **pas calibré** : la profondeur réelle du carnet d'Arc
  est inconnue.
- Le rail lent est modélisé par son coût et sa latence, mais le **délai de règlement
  J+2 n'est pas simulé** — les rééquilibrages sont instantanés dans la simulation. Cela
  avantage légèrement le corridor sans stablecoin.
- Le bootstrap des trajectoires est indépendant et détruit l'autocorrélation des flux.
  Un bootstrap par blocs la conserverait, au prix d'un paramètre de longueur à calibrer.
