# NEAP — Intraday Multi-Currency Treasury Engine
### Spécification technique — ETHOnline 2026
> Nom de code provisoire (ex-NOSTRO). Voir §0.2 pour les alternatives.
> Statut : **brouillon v0.1 — cadrage**. Les sections marquées ⚠️ contiennent des décisions non tranchées.

---

## 0. Métadonnées

### 0.1 Résumé exécutable

Une institution qui promet des paiements transfrontaliers instantanés doit pré-financer chaque
devise de chaque corridor. Ce capital est immobilisé, non rémunéré, et porte une exposition de
change non couverte. NEAP remplace ce pré-financement statique par un moteur de contrôle
stochastique : il prévoit les flux nets par corridor, calcule les bandes de rééquilibrage optimales
par devise, et ne déclenche une exécution PvP sur le moteur FX d'Arc que lorsque le gain marginal
(capital libéré + réduction de VaR) dépasse le coût marginal d'exécution.

Le calcul de risque tourne dans un handler confidentiel Chainlink CRE (TEE), parce qu'aucune
institution ne publiera ses positions de trésorerie en clair sur une chaîne publique. La
gouvernance opérationnelle (rôles, limites, séparation des devoirs) repose sur les org wallets Privy.

### 0.2 Nom

**NEAP.** La marée de morte-eau est celle de plus faible amplitude : le moment où
l'écart entre pleine et basse mer est le plus petit. C'est exactement ce que le moteur
fait d'un buffer de trésorerie.

Le nom précédent, FLOAT, désignait bien le capital immobilisé en transit — le terme exact
du métier. Il a été abandonné pour deux raisons. D'abord une collision : Float Financial
est une fintech canadienne financée à 70 M$ qui fait cartes corporate, notes de frais et
change, c'est-à-dire le même voisinage. Ensuite parce qu'un mot du dictionnaire anglais
n'est ni cherchable ni possédable, et qu'il porte en plus un sens parasite pour un public
de développeurs.

NEAP demande un pas de métaphore que la plupart des lecteurs ne franchiront pas seuls.
Le sous-titre doit donc rester strictement littéral — *intraday multi-currency treasury
engine* — et ne jamais essayer d'être poétique à son tour.

### 0.3 Sponsors et mapping des tracks

| Sponsor | Track visé | Dotation | Ce qui doit être démontré |
|---|---|---|---|
| Chainlink | Best Confidential Workflow (CRE TEE handlers) | 2 000 $ | intégration TEE **significative** + preuve de simulation/déploiement |
| Privy | Best B2B Financial Product | 2 500 $ | org wallets, workflow fonctionnel, démo + source |
| Arc (Circle) | Best DeFi / Onchain Finance | 3 500 $ | MVP fonctionnel, diagramme d'architecture, démo vidéo |

Total accessible : 8 000 $. **Le critère n'est pas la dotation mais l'irréductibilité** : retirer
Chainlink expose les positions, retirer Arc réintroduit le risque de règlement Herstatt, retirer
Privy supprime le contrôle à quatre yeux. Aucun des trois n'est décoratif.

---

## 1. Problème et périmètre

### 1.1 Le problème métier, précisément

Soit un émetteur de monnaie électronique opérant N corridors. Pour honorer un paiement
EUR → USD en moins de 10 secondes, il doit détenir un solde USD **avant** de recevoir les EUR.
Trois coûts en découlent :

1. **Coût de portage** — le solde pré-financé ne rapporte rien (ou le taux sans risque au mieux),
   alors que le coût du capital de l'institution est supérieur.
2. **Risque de change** — la position longue USD / courte EUR est une position directionnelle
   subie, non désirée, non couverte.
3. **Coût de rupture** — si le solde s'épuise, le paiement échoue ou nécessite un funding
   d'urgence à prix cassé. Ce coût est fortement asymétrique et c'est lui qui justifie le buffer.

L'arbitrage est un problème de contrôle stochastique classique mal résolu en pratique, parce que
les trésoreries bancaires rééquilibrent selon un calendrier (fin de journée) plutôt que selon un
signal, et sur des rails (correspondent banking) dont le coût fixe est si élevé qu'un
rééquilibrage intraday est économiquement impossible.

### 1.2 Ce que change un rail à finalité sub-seconde et gas déterministe

C'est la thèse du projet, et elle doit être énoncée telle quelle aux juges :

> Le coût fixe d'un rééquilibrage sur Arc est de l'ordre de quelques cents en USDC, avec une
> finalité de ~350 ms. Dans le modèle de Miller-Orr, la largeur de bande optimale croît en
> γ^(1/3) où γ est ce coût fixe. Diviser γ par 10 000 réduit la bande d'un facteur ~21.
> **Le buffer de trésorerie optimal s'effondre.** Le projet quantifie cet effondrement.

C'est un résultat, pas une opinion, et il est démontrable par backtest. C'est le cœur du pitch.

### 1.3 Périmètre v1 (hackathon)

**Dans le périmètre :**
- 4 devises : USD, EUR, GBP, plus une devise « exotique » simulée (voir §1.4).
- Un tenant unique (une institution), multi-utilisateurs avec rôles.
- Prévision de flux, calcul de bandes, calcul de VaR/ES, décision, exécution, journal.
- Backtest historique reproductible + une exécution live en démo.

**Hors périmètre, explicitement :**
- Multi-tenant / netting entre institutions (c'est un autre projet — cf. concept HERSTATT).
- Rampes fiat on/off. On raisonne en stablecoins bout en bout.
- Comptabilité de couverture IFRS 9, reporting réglementaire.
- Optimisation du routage de paiement lui-même (c'est le concept CORRIDOR).

### 1.4 ⚠️ Problématique de périmètre n°1 : stablecoins ≠ devises

Arc règle en stablecoins. Or les corridors qui font mal à une néobanque sont ceux où **aucun
stablecoin n'existe** (PHP, NGN, INR, BRL). Trois postures possibles :

| Posture | Description | Risque |
|---|---|---|
| **A — Honnête restreinte** | On ne traite que USD/EUR/GBP, là où USDC/EURC/GBPx existent. On dit que c'est le périmètre où la thèse s'applique aujourd'hui. | Un juge dira « donc ça ne résout pas le vrai problème » |
| **B — Hybride** | On modélise 3 devises réelles + 1 jambe synthétique représentant un corridor sans stablecoin, réglée hors chaîne, dont le coût fixe reste élevé. Le moteur arbitre entre les deux régimes. | Complexité accrue, une partie mockée |
| **C — Ambitieuse** | Tout est stablecoin, on suppose l'existence d'un EMT pour chaque devise. | Peu crédible face à un juge Circle |

**Recommandation : B.** C'est la seule posture qui rend le modèle *intéressant* — parce qu'elle
crée un vrai arbitrage entre un rail à coût fixe faible et un rail à coût fixe élevé, ce qui est
exactement la situation d'une trésorerie en transition. Et elle est intellectuellement honnête.

### 1.5 ⚠️ Problématique de périmètre n°2 : le basis risk EURC/EUR

Couvrir une exposition EUR avec de l'EURC ne couvre pas parfaitement : il reste le **basis risk**
entre l'EURC et l'euro de banque centrale (risque de dé-peg, risque émetteur, risque de
liquidité de rachat). Ce risque n'est pas dans le modèle de VaR classique et il est
structurellement invisible dans les données historiques courtes (le peg tient... jusqu'à ce
qu'il ne tienne plus — cf. USDC mars 2023).

**Traitement proposé :** un add-on explicite au capital requis,
`add_on_basis = h_depeg × exposition`, avec `h_depeg` un haircut paramétrable (défaut 50 bps).
Le nommer et le paramétrer, plutôt que de faire semblant qu'il n'existe pas, est un signal fort
de maturité. **Aucun projet hackathon ne mentionnera le basis risk stablecoin/fiat.**

---

## 2. Acteurs et parcours

### 2.1 Rôles

| Rôle | Peut | Ne peut pas |
|---|---|---|
| **Risk Officer** | définir les limites, les haircuts, l'aversion au risque κ, les plafonds par devise | déclencher une exécution |
| **Treasurer** | approuver/rejeter une proposition de rééquilibrage, exécuter dans les limites | modifier les limites |
| **Operator (agent)** | exécuter automatiquement en dessous du seuil d'auto-approbation | dépasser le seuil, modifier quoi que ce soit |
| **Auditor** | lire tout, exporter le journal | écrire |

La **séparation des devoirs** entre Risk Officer et Treasurer n'est pas cosmétique : c'est
l'exigence n°1 de tout dispositif de contrôle interne bancaire, et c'est ce qui justifie
l'usage des org wallets Privy plutôt qu'une simple clé.

### 2.2 Parcours principal — un cycle de décision (« epoch »)

```
 t+0ms    Déclencheur (cron 15 min, ou franchissement de seuil, ou flux entrant important)
 t+50ms   Collecte : soldes par devise, engagements pending, taux FX (Data Streams), gas
 t+100ms  Chiffrement des données sensibles → soumission au workflow CRE
 t+~2s    Le handler TEE : prévoit les flux, calcule Σ, VaR/ES, résout les bandes,
          évalue la fonction objectif, produit un plan d'ordres OU un no-op
 t+~3s    Le rapport signé + attesté est publié on-chain (ReportVerifier)
 t+~3s    Si montant < seuil d'auto-approbation → exécution automatique
          Sinon → notification au Treasurer, attente d'approbation Privy
 t+~4s    ExecutionRouter demande un quote RFQ, vérifie la déviation vs oracle, exécute le PvP
 t+~4.4s  Finalité. Journal on-chain. Mise à jour de l'état.
```

### 2.3 Parcours de crise (à démontrer)

Un flux sortant inattendu de grande taille vide un corridor. Le seuil bas est franchi, le
déclencheur événementiel se lève hors cycle, la bande est recalculée avec la volatilité récente
(qui a monté), et un rééquilibrage d'urgence est proposé — au-dessus du seuil d'auto-approbation,
donc il exige l'approbation humaine. **Ce parcours est celui à filmer** : il montre le système
sous stress et la gouvernance qui tient.

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│  COUCHE PRÉSENTATION                                                     │
│  Dashboard Next.js — soldes, bandes, VaR, historique, backtest, approba- │
│  tions. Auth via Privy (rôles).                                          │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
┌────────────────────────────────┴────────────────────────────────────────┐
│  COUCHE ORCHESTRATION (off-chain, service TypeScript)                    │
│  • Ingestion des flux (générateur synthétique / rejeu)                   │
│  • Calibration offline (σ, Σ, saisonnalité, η impact) — HORS TEE         │
│  • Chiffrement des inputs, déclenchement des workflows CRE               │
│  • Backtester (rejoue N jours, compare politiques)                       │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
┌────────────────────────────────┴────────────────────────────────────────┐
│  MOTEUR DE RISQUE — Chainlink CRE, handler confidentiel (TEE)            │
│  in  : soldes chiffrés, engagements chiffrés, limites chiffrées          │
│  in  : taux FX (Data Streams, public), gas, quotes indicatifs (public)   │
│  out : RebalanceReport signé + attestation                               │
│  Contenu : prévision → Σ → VaR/ES → bandes → fonction objectif → plan    │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
┌────────────────────────────────┴────────────────────────────────────────┐
│  COUCHE ON-CHAIN — Arc                                                   │
│  TreasuryPolicy   limites, bandes, rôles, seuils, timelock               │
│  ReportVerifier   vérifie signature/attestation, nonce, fraîcheur, bornes│
│  RebalanceVault   détient les soldes opérationnels, exécute, journalise  │
│  ExecutionRouter  IFxVenue → adaptateur Arc RFQ | adaptateur mock        │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
┌────────────────────────────────┴────────────────────────────────────────┐
│  CUSTODY & GOUVERNANCE — Privy org wallets                               │
│  Rôles, policies, limites de vélocité, approbations, audit trail         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.1 ⚠️ Problématique d'architecture : où passe la frontière on-chain / off-chain ?

C'est **le** piège du projet. Un moteur quantitatif est naturellement off-chain ; si le smart
contract se réduit à un `emit Rebalanced(...)`, les juges le verront immédiatement et le projet
sera classé « dashboard avec un contrat décoratif ».

Le contrat doit porter quatre choses non triviales, et il faut pouvoir le défendre :

1. **La politique fait autorité** — les bandes et limites vivent on-chain, versionnées, avec
   timelock sur les modifications. Le moteur off-chain ne peut pas s'auto-autoriser.
2. **La vérification du rapport** — signature du DON, attestation TEE, nonce anti-rejeu,
   fraîcheur, et bornes de sanité indépendantes du rapport lui-même.
3. **L'exécution atomique** — le PvP et la mise à jour d'état dans une transaction.
4. **Le journal opposable** — la trace d'audit est le produit, pas un sous-produit. Une
   trésorerie a besoin de prouver *pourquoi* une décision a été prise, avec quels paramètres.

Formulation défendable en pitch : *« le contrat n'exécute pas le modèle, il contraint le modèle »*.

---

## 4. Modèle quantitatif

### 4.1 Le principe directeur : une seule fonction objectif

⚠️ **Problématique quantitative n°1 — et la plus subtile.** Dans le concept initial il y avait
deux règles de décision : la bande de Miller-Orr, et la règle « exécuter si ΔVaR × coût du capital
> coût d'exécution ». Ces deux règles **peuvent se contredire** : la bande dit « ne rien faire »,
la règle VaR dit « couvrir ». Laquelle gagne ?

La réponse de design : **il n'y a qu'une seule règle**. La bande n'est pas une entrée du système,
c'est le *résultat* de la minimisation. On pose un coût total par période :

```
J = E[ Σ_t ( r·B_t          coût de portage du solde
            + γ·1{rebal_t}   coût fixe de rééquilibrage
            + s·Q_t          coût variable (spread + impact)
            + κ·VaR_t        coût du risque de change
            + c_b·1{B_t<L} ) ]  coût de rupture
```

et on cherche la politique qui minimise J. Sous hypothèses fortes (flux browniens sans drift,
pas de risque FX), la solution analytique **est** Miller-Orr. Quand on relâche les hypothèses,
on résout numériquement. Miller-Orr devient donc le *cas particulier vérifiable* qui valide
l'implémentation, pas le modèle final.

**C'est ce raisonnement qui doit être dans le pitch.** Il montre que tu sais pourquoi tu utilises
un modèle, et où il cesse d'être valide.

### 4.2 Prévision des flux nets

Modèle : processus de Poisson composé avec intensité saisonnière.

```
Arrivées :  N_t ~ Poisson( λ_c · s_hour(t) · s_dow(t) )
Montants :  X_i ~ LogNormal(μ_c, σ_c)   (queue épaisse, réaliste pour des paiements)
Flux net :  F_t = Σ entrants − Σ sortants
Prévision : F̂_{t+1} = α·F_t + (1−α)·F̂_t, corrigé de la saisonnalité
```

⚠️ **Problématique : les flux ont un drift.** Un corridor est structurellement déficitaire
(EUR → PHP : les flux vont dans un sens). Miller-Orr suppose un drift nul et produit des bandes
symétriques, ce qui est faux dans ce cas. Deux options :

- **Option 1** — Miller-Orr avec drift (bandes asymétriques, formule de Constantinides). Rigoureux,
  mais la formule est lourde et peu lisible en démo.
- **Option 2** — résolution numérique : simuler 200 trajectoires de flux, chercher (L, Z, H) par
  optimisation directe sur J. Plus lent, plus général, et **plus démontrable** (on peut montrer la
  surface de coût et le minimum).

Recommandation : **Option 2**, avec Miller-Orr analytique comme test de non-régression sur le cas
drift-nul. C'est aussi ce qui permet d'intégrer proprement le terme de VaR, que la formule fermée
ne sait pas absorber.

### 4.3 Volatilité et matrice de covariance

```
σ EWMA (RiskMetrics) :  σ²_t = λ·σ²_{t−1} + (1−λ)·r²_{t−1},  λ = 0.94
Covariance :            Σ̂ = δ·F + (1−δ)·S   (shrinkage Ledoit-Wolf)
```

⚠️ **Problématique : l'horizon de risque n'est pas « 1 jour ».** Sur un rail 24/7 à finalité
350 ms, l'horizon pertinent est le temps pendant lequel on *subit* la position, c'est-à-dire :

```
h = temps jusqu'au prochain epoch de décision + latence d'exécution + marge
```

Avec un epoch de 15 minutes, h ≈ 16 minutes, pas 24 heures. La VaR chute d'un facteur √(96).
**C'est un des résultats les plus vendeurs du projet** : la fréquence de décision est elle-même
un levier de réduction du capital requis, et on peut tracer la courbe capital(fréquence).

⚠️ **Problématique : le scaling √t casse le week-end.** Les stablecoins tradent 24/7, le fiat non.
Le gap du lundi matin n'est pas modélisé par une racine carrée du temps. Traitement : facteur de
scaling empirique `w_weekend` calibré sur l'historique des gaps de clôture/ouverture, appliqué
aux fenêtres qui traversent un week-end. À paramétrer, pas à ignorer.

⚠️ **Problématique : les corrélations se cassent en crise.** Le shrinkage Ledoit-Wolf stabilise
l'estimation mais ne protège pas contre un changement de régime. Mitigation minimale : un scénario
de stress « corrélations → 1 » dans le backtest, affiché à côté du cas central.

### 4.4 Mesures de risque

```
VaR paramétrique (affichage) :   VaR_α = z_α · √(w'Σw) · √h
ES normale (décision) :          ES_α = σ · φ(z_α)/(1−α) · √h
Add-on basis stablecoin :        A_basis = h_depeg · |exposition|
Capital de risque :              RC = ES_97.5 + A_basis
```

⚠️ **Problématique : la VaR paramétrique suppose la normalité.** Les rendements FX ont des
queues épaisses et la VaR n'est pas sous-additive (elle peut pénaliser la diversification).
Décision : **VaR pour l'affichage** (parce que c'est le langage du métier), **ES pour la
décision** (parce que c'est cohérent et sensible à la queue). Si le temps le permet : Filtered
Historical Simulation (résidus standardisés rééchantillonnés) comme troisième estimateur, pour
montrer l'écart entre les trois — un tableau comparatif VaR-normale / ES / FHS est un excellent
signal de compétence.

### 4.5 Couverture

```
Ratio de couverture à variance minimale :  h* = ρ · σ_spot / σ_hedge
```

⚠️ **Problématique : ne pas sur-couvrir.** Couvrir EUR/USD réduit mécaniquement l'exposition
GBP/USD via la corrélation. Le calcul doit être fait **au niveau du portefeuille**, pas devise par
devise, sinon on paie deux fois pour le même risque. C'est un piège classique et le montrer
(« couverture naïve par devise : X bps ; couverture portefeuille : 0.6X bps ») est un point fort.

### 4.6 Coût d'exécution

```
Coût total d'un ordre de taille Q :
   C(Q) = s_rfq·Q + gas_usdc + η·Q^(3/2)   (impact temporaire, forme classique)
```

⚠️ **Problématique majeure : η n'est pas calibrable.** Arc est en mainnet depuis quelques jours ;
la profondeur du carnet RFQ est inconnue et probablement faible. Traitement :
- exposer η comme paramètre visible dans l'UI,
- afficher la sensibilité du résultat à η (analyse de sensibilité sur 3 valeurs),
- ne **jamais** présenter un chiffre de gain sans indiquer l'hypothèse d'impact.

Un juge Circle connaît la profondeur réelle de son propre carnet. Prétendre l'avoir calibrée
serait détecté immédiatement. Assumer l'incertitude est la bonne stratégie.

### 4.7 Paramètres exposés

| Paramètre | Symbole | Défaut | Source / justification |
|---|---|---|---|
| Coût du capital | r | 6 %/an | hypothèse institution ; à discuter |
| Aversion au risque | κ | 0.10 | calibré pour que le terme de risque pèse ~20 % de J |
| Coût de rupture | c_b | 250× γ | asymétrie forte, c'est lui qui crée le buffer |
| Décroissance EWMA | λ | 0.94 | RiskMetrics standard |
| Haircut de-peg | h_depeg | 50 bps | jugement ; aucune donnée fiable |
| Impact | η | à afficher | non calibrable (§4.6) |
| Période d'epoch | Δt | 15 min | arbitrage coût de calcul / réactivité |
| Seuil d'auto-approbation | — | 100 k USDC | politique, on-chain |

⚠️ **Chaque défaut ci-dessus est un jugement, pas une mesure.** La spec doit l'assumer et l'UI
doit rendre les paramètres modifiables en direct pendant la démo — c'est plus convaincant qu'un
chiffre présenté comme une vérité.

---

## 5. Données

### 5.1 ⚠️ Problématique fondatrice : il n'existe aucune donnée réelle accessible

Personne ne publie les flux de paiement d'une néobanque par corridor. C'est la contrainte
structurelle du projet et elle doit être traitée frontalement, pas contournée.

| Option | Description | Verdict |
|---|---|---|
| A — Générateur synthétique | Poisson composé calibré sur des agrégats publics | ✅ retenu |
| B — Proxy public | statistiques SEPA de la BCE, corridors de remittance Banque Mondiale | ✅ retenu **pour calibrer A** |
| C — Rejeu de flux USDC on-chain | transferts réels observés sur Ethereum/Base | ⚠️ intéressant mais ce ne sont pas des flux de paiement client |
| D — Prétendre à des données réelles | — | ❌ disqualifiant |

**Stratégie retenue : A calibré sur B, avec seed déterministe.** Le générateur est un composant
livré, documenté, avec ses paramètres de calibration et leur source. La reproductibilité (même
seed → mêmes résultats) est une exigence : un backtest non reproductible n'a aucune valeur de
preuve, et un juge peut demander à le rejouer.

Ajouter un test de sanité : les propriétés statistiques du flux généré (moyenne, variance,
autocorrélation, saisonnalité hebdomadaire) doivent correspondre aux agrégats publics à ±X %.
C'est ce test qui rend le générateur défendable.

### 5.2 Données de marché

| Donnée | Source live | Source d'historique | Problématique |
|---|---|---|---|
| EUR/USD, GBP/USD | Chainlink Data Streams | séries de la BCE | ⚠️ **incohérence de sources** : σ est calibré sur des données BCE quotidiennes, puis appliqué à un flux Data Streams haute fréquence. Les deux ne mesurent pas la même chose. À documenter, et si possible à corriger par un facteur d'échelle mesuré. |
| Prix EURC/USDC | quote RFQ Arc | inexistant | pas d'historique → σ du basis non estimable → d'où le haircut forfaitaire §1.5 |
| Gas USDC | RPC Arc | — | doit être estimé **avant** décision, pas après |

⚠️ **Problématique : la fraîcheur des données est une hypothèse de sécurité.** Si le taux FX
utilisé pour décider a 3 minutes de retard et que le marché a bougé, la décision est mauvaise et
l'exécution peut être arbitrée. Le contrat doit rejeter tout rapport dont les inputs dépassent un
seuil de staleness, et le moteur doit borner la déviation autorisée entre le prix de décision et
le prix d'exécution.

---

## 6. Le workflow confidentiel Chainlink CRE

### 6.1 Pourquoi le TEE est nécessaire (l'argument à ne pas rater)

Sans confidentialité, le projet est une démonstration académique. Une institution qui publierait
ses soldes par devise, ses engagements à venir et ses limites internes offrirait à ses
contreparties une carte complète de sa position de liquidité — c'est-à-dire de quoi la
positionner contre elle. **Le TEE n'est pas un bonus technique, c'est la condition d'existence
commerciale du produit.** C'est la phrase à dire au juge Chainlink.

### 6.2 Découpage calcul / confidentialité

⚠️ **Problématique : que met-on réellement dans le TEE ?** Un TEE a des contraintes de ressources
et de temps. Un backtest sur 90 jours n'y a pas sa place. Découpage proposé :

| Étage | Où | Pourquoi |
|---|---|---|
| Calibration (σ, Σ, saisonnalité, η) | **hors TEE**, offline | lourd, et les paramètres agrégés sont peu sensibles |
| Résolution des bandes par simulation | **hors TEE** si trop lourd, sinon dedans | ⚠️ décision de charge à mesurer |
| Décision par epoch (VaR, objectif, plan) | **dans le TEE** | c'est là que vivent les positions |
| Backtest | hors TEE, entièrement | outil d'analyse, pas de production |

⚠️ Si la résolution des bandes sort du TEE, elle doit le faire **sans voir les soldes** — elle ne
prend que des paramètres statistiques (σ, λ, coûts). C'est faisable et c'est même propre :
la bande est une fonction des paramètres, pas de l'état. À vérifier que le raisonnement tient.

### 6.3 Interface du handler

```
Input chiffré      : balances[currency], commitments[currency][horizon], limits, policyVersion
Input public       : fxRates (Data Streams), gasPrice, indicativeQuotes, epoch, nonce
Output (rapport)   : { epoch, nonce, expiry, policyVersion, orders[], varBefore, varAfter,
                       costEstimate, inputsHash, attestation }
```

### 6.4 ⚠️ Problématique majeure : la fuite d'information par les sorties

Chiffrer les entrées ne sert à rien si la sortie révèle l'entrée. Publier
`orders = [{EUR→USD, 3 214 500}]` révèle une grande partie de la position. Un observateur qui
suit les rapports sur plusieurs epochs peut reconstruire les flux par différence.

Options de mitigation, par ordre de coût croissant :

| Option | Effet | Coût |
|---|---|---|
| Quantification (arrondi à 100 k) | réduit la précision, pas la tendance | nul |
| Bruit calibré (differential privacy) | protège statistiquement | dégrade la décision |
| Batching temporel aléatoire | casse la corrélation temporelle | ajoute de la latence, donc du risque |
| Commitment on-chain + exécution via transferts confidentiels Arc | protège réellement le montant | complexité élevée, dépend d'Arc |
| Ne publier que le hash + preuve de conformité aux bornes | protection forte | il faut prouver les bornes sans révéler |

**Recommandation v1 : quantification + commitment.** On publie `hash(orders)`, les bornes
vérifiées, et les métriques agrégées (ΔVaR en %, pas en montant). Le montant exact ne transite
que vers le venue. **Mais il faut être explicite** : la v1 fuit encore de l'information par la
taille de la transaction observable on-chain, sauf si les transferts confidentiels d'Arc sont
utilisables. Le dire est plus fort que le cacher.

### 6.5 ⚠️ Problématiques ouvertes CRE (risque bloquant n°1)

À vérifier **avant d'écrire une ligne de code** :
- Les TEE handlers CRE sont-ils accessibles en testnet public sans allowlist ? Quotas ?
- Quel langage / runtime pour le handler ? Quelles bibliothèques mathématiques disponibles ?
  (si pas de bibliothèque d'algèbre linéaire, le calcul de `w'Σw` sur 4 devises reste faisable
  à la main — mais il faut le savoir)
- Quel est le format d'attestation, et un contrat peut-il le vérifier on-chain de façon économique ?
- Comment les secrets sont-ils fournis au handler (clé de déchiffrement) ? Qui les détient ?
- Temps d'exécution maximal, taille maximale des inputs ?
- CRE tourne-t-il *sur* Arc, ou faut-il un pont vers Arc ? ⚠️ **Si CRE ne supporte pas Arc comme
  chaîne de destination, toute l'architecture est à revoir.** C'est la question n°1 à poser au
  support Chainlink dès l'ouverture du hackathon.

**Plan B si CRE-TEE est inaccessible :** implémenter le handler comme un service isolé avec
attestation simulée et une interface identique, en documentant honnêtement le mock. Mais le track
exige une « meaningful TEE integration » avec preuve de simulation ou de déploiement — un mock
complet ferait probablement perdre le prix Chainlink. **Décider tôt.**

---

## 7. Intégration Arc

### 7.1 Ce qu'on utilise

| Capacité Arc | Usage dans NEAP | Criticité |
|---|---|---|
| Gas en USDC | rend le coût fixe γ déterministe en dollars — terme direct de la fonction objectif | **essentielle** |
| Finalité ~350 ms | réduit l'horizon de risque h, donc la VaR, donc le buffer | **essentielle à la thèse** |
| Moteur FX natif (RFQ + PvP) | exécution des jambes de rééquilibrage sans risque de règlement | **essentielle** |
| Transferts confidentiels | masquer la taille des ordres (§6.4) | souhaitable |

### 7.2 ⚠️ Problématiques Arc (risque bloquant n°2)

- **Le mainnet a été lancé le 16 septembre 2026.** Documentation, SDK, faucet testnet, stabilité
  du RPC : tout est neuf. Prévoir du temps d'intégration bien supérieur à une chaîne EVM mature.
- **Le RFQ est-il ouvert aux développeurs, ou réservé à des market makers whitelistés ?**
  C'est très probablement un système institutionnel avec onboarding. Si c'est le cas, le cœur du
  projet n'est pas accessible. → **Mitigation obligatoire dès le départ : l'interface `IFxVenue`
  avec deux implémentations, `ArcFxVenue` et `MockFxVenue`.** Le moteur ne doit jamais dépendre
  directement d'Arc. C'est du bon design de toute façon, et ça sauve le projet si l'accès manque.
- **Liquidité EURC/USDC réelle** : si le carnet est vide en testnet, aucune exécution réaliste
  n'est possible → le mock devient la voie principale de démonstration, et le déploiement Arc
  devient la preuve d'intégration.
- **Transferts confidentiels** : quelles primitives exactement ? Compatibles avec un appel depuis
  un contrat ? Surcoût gas ? Interopérables avec le RFQ ? Probablement pas tout à la fois.
- **MEV / mempool** : Arc est un BFT type Tendermint. Y a-t-il un mempool public ? Un rééquilibrage
  annoncé avant exécution est front-runnable. ⚠️ À investiguer : c'est un vrai risque financier,
  pas une question théorique.
- **Finalité vs sécurité économique** : 350 ms de finalité BFT avec 11 validateurs institutionnels
  — le modèle de confiance est différent d'une chaîne permissionless. À énoncer honnêtement dans
  la section « trust assumptions ».

---

## 8. Gouvernance et custody — Privy

### 8.1 Ce qu'on construit

- Org wallet par entité, avec les 4 rôles de §2.1.
- Policies : plafond par transaction, plafond par fenêtre glissante (velocity limit), allowlist
  de destinations, restriction par devise.
- Flux d'approbation : au-dessus du seuil, le Treasurer approuve explicitement.
- Journal des approbations exporté vers le journal on-chain.

### 8.2 ⚠️ Problématiques Privy

- **Privy fait-il du quorum m-sur-n natif, ou seulement des policies mono-signataire ?**
  Si pas de quorum, il faut le porter au niveau du contrat (multisig), ce qui crée une redondance
  de modèle d'autorisation entre Privy et la chaîne. → clarifier tôt qui fait autorité.
- **La séparation des devoirs est-elle réellement applicable ?** Empêcher un Risk Officer de
  déclencher une exécution suppose que les rôles soient portés par des clés distinctes ET que le
  contrat les distingue. Un contrôle uniquement côté UI n'est pas un contrôle.
- **Trust assumption honnête** : un org wallet Privy est une custody déléguée. Une banque ne
  mettrait pas sa trésorerie complète derrière. Positionnement à assumer : **wallet opérationnel
  plafonné**, le gros de la trésorerie restant en custody froide. Le dire renforce la crédibilité.
- **Privy supporte-t-il Arc comme chaîne ?** ⚠️ Question bloquante n°3. Une chaîne lancée il y a
  quelques jours n'est probablement pas dans la liste par défaut. Vérifier le support de chaînes
  EVM arbitraires par chain ID.

---

## 9. Contrats

### 9.1 Inventaire

| Contrat | Responsabilité | Complexité |
|---|---|---|
| `TreasuryPolicy` | limites, seuils, rôles, versionnement, timelock sur modification | moyenne |
| `ReportVerifier` | vérifie signature DON + attestation TEE, nonce, expiry, inputsHash | **élevée** |
| `RebalanceVault` | détient les soldes opérationnels, exécute le plan, journalise | moyenne |
| `ExecutionRouter` | `IFxVenue` → `ArcFxVenue` \| `MockFxVenue` ; contrôle de déviation | moyenne |
| `CircuitBreaker` | pause, plafonds de sanité indépendants du rapport | faible |

### 9.2 Machine à états d'un ordre

```
PROPOSED ──verify──> VERIFIED ──approve──> APPROVED ──quote──> QUOTED
                         │                     │                  │
                      REJECTED              EXPIRED          ──execute──> SETTLED
                                                                  │
                                                                FAILED ──> COMPENSATED
```

### 9.3 ⚠️ Problématiques contrat

- **Idempotence.** Un ordre rejoué = un double rééquilibrage = une position doublée. Clé
  d'idempotence obligatoire : `keccak(policyVersion, epoch, nonce, ordersHash)`, consommée
  atomiquement. C'est le bug le plus coûteux possible dans ce domaine.
- **Atomicité de la jambe FX.** Si le swap réussit mais la comptabilisation échoue, l'état
  divergerait. Le PvP d'Arc est-il atomique du point de vue du contrat appelant ? Si non,
  machine à états avec compensation explicite (état `COMPENSATED`).
- **Contrôle de déviation.** Le contrat compare le prix RFQ obtenu au prix oracle et rejette
  au-delà d'un seuil (ex. 30 bps). Sans ça, un venue malveillant ou un carnet vide exécute au
  pire prix. **C'est la protection la plus importante du système.**
- **Staleness.** Rejet de tout rapport dont `expiry < block.timestamp` ou dont les inputs FX
  dépassent l'âge maximal.
- **Bornes de sanité indépendantes.** Le contrat ne fait pas confiance au rapport : plafond dur
  en % de la trésorerie par epoch, plafond absolu, plafond glissant sur 24 h. Si le modèle
  déraille (bug de calibration, division par une volatilité nulle), le contrat contient les dégâts.
- **Kill switch** détenu par un rôle distinct, sans timelock (l'urgence ne se planifie pas).
- Pas de proxy upgradeable en v1 — complexité et surface d'attaque inutiles pour un hackathon ;
  un kill switch + redéploiement suffit.
- Réentrance sur les appels au venue → `nonReentrant` + pattern checks-effects-interactions.

---

## 10. Sécurité et modèle de confiance

### 10.1 Hypothèses à énoncer explicitement

| On fait confiance à | Pour quoi | Si c'est faux |
|---|---|---|
| l'enclave TEE | confidentialité et intégrité du calcul | positions exposées, décisions falsifiées |
| le DON Chainlink | signature du rapport | rapports forgés → bornes de sanité contrat limitent les dégâts |
| Data Streams FX | prix corrects | mauvaise décision → contrôle de déviation limite les dégâts |
| les validateurs Arc | finalité | double dépense théorique |
| Privy | garde des clés opérationnelles | vol plafonné par les velocity limits |
| l'émetteur du stablecoin | maintien du peg, non-gel | perte non couverte — c'est le basis risk §1.5 |

Cette table **est un livrable**. Un juge issu de la finance jugera un projet sur sa capacité à
énoncer ses hypothèses de confiance, pas sur son absence de dépendances.

### 10.2 Surfaces d'attaque spécifiques

- **Manipulation d'oracle** → bornes de déviation, comparaison multi-sources, rejet de staleness.
- **Front-running du rééquilibrage** (§7.2) → dépend du mempool d'Arc, à investiguer.
- **Fuite par les sorties** (§6.4) → quantification + commitment.
- **Compromission de l'opérateur** → velocity limits + seuil d'auto-approbation bas.
- **Grief par déclenchement** : un attaquant qui provoque des micro-flux pour forcer des
  rééquilibrages coûteux. Mitigation : cooldown minimal entre epochs, coût fixe intégré à J
  (le modèle refuse déjà les rééquilibrages non rentables — c'est une propriété du design).
- **Division par zéro / volatilité nulle** en période calme → plancher sur σ. Bug classique et
  dévastateur : σ→0 fait tendre la bande vers 0 et déclenche un rééquilibrage permanent.

---

## 11. Réalisme réglementaire (une slide, pas un chapitre)

⚠️ Ces questions seront posées par un juge issu du secteur. Il faut une réponse d'une phrase
chacune, pas un développement.

- **MiCA** — un stablecoin EUR utilisé en trésorerie est un EMT ; usage encadré, émetteur
  autorisé requis. EURC est émis par Circle avec une entité européenne : réponse disponible.
- **Safeguarding** — les fonds de clients d'un EMI doivent être ségrégués. Le pré-financement
  est-il du fonds propre ou du fonds client ? **Réponse : fonds propre uniquement en v1**, et
  c'est une limitation à énoncer.
- **Comptabilité de couverture (IFRS 9)** — hors périmètre, mais reconnaître que la couverture
  crée du bruit de P&L si elle n'est pas documentée en hedge accounting.
- **Reporting** — CRE sait formater en ISO 20022, ce qui permet d'émettre les mouvements vers un
  back-office existant. C'est un excellent point de conclusion : le système ne demande pas à la
  banque de changer sa plomberie.

---

## 12. Démonstration

### 12.1 ⚠️ Problématique : comment prouver un gain sur 90 jours en 3 minutes ?

Le résultat du projet est statistique, la démo est temporelle. Résolution en trois temps :

1. **Le backtest, pré-calculé** (20 s) — une courbe : capital immobilisé sous politique statique
   vs NEAP, sur 90 jours simulés, avec ΔVaR et coûts d'exécution cumulés. Trois politiques
   comparées : statique, calendaire (fin de journée), NEAP.
2. **La sensibilité** (20 s) — le même graphe recalculé en direct quand on bouge κ ou η dans l'UI.
   Ça prouve que le modèle est vivant et non un chiffre en dur.
3. **Une exécution live** (60 s) — le parcours de crise §2.3 : choc de flux, franchissement de
   seuil, calcul TEE, proposition au-dessus du seuil, approbation Privy par un second rôle,
   exécution PvP sur Arc, finalité, journal.

### 12.2 Métriques à afficher (et à ne pas gonfler)

| Métrique | Attendu | Piège |
|---|---|---|
| Capital immobilisé | −30 à −45 % | dépend entièrement de γ et c_b — afficher les hypothèses |
| VaR portefeuille | −40 à −60 % | provient surtout de la réduction d'horizon, pas du modèle — le dire |
| Coûts d'exécution | +10 à +20 % | **doit augmenter** : on rééquilibre plus souvent. Le cacher serait suspect. |
| Nombre de ruptures | 0 | à contrainte égale, c'est la vraie preuve |

**Afficher l'augmentation du coût d'exécution est plus convaincant que de la masquer.** Un juge
quantitatif cherche l'arbitrage ; un projet qui n'affiche que des améliorations n'a pas de modèle.

### 12.3 Honnêteté sur les mocks

Une section « ce qui est réel / ce qui est simulé » dans le README et dans la vidéo. Les données
de flux sont synthétiques, η n'est pas calibré, le venue peut être mocké. **Les juges ETHGlobal
valorisent cette transparence et pénalisent lourdement sa découverte tardive.**

---

## 13. Plan de livraison

### 13.1 Jalon 0 — à faire AVANT d'écrire du code (quelques heures)

Les trois questions bloquantes, à poser dans les Discord sponsors dès l'ouverture :

1. **CRE** : les TEE handlers sont-ils accessibles librement, et Arc est-il une chaîne de
   destination supportée ?
2. **Arc** : le moteur FX RFQ est-il appelable par un contrat de développeur en testnet, ou
   whitelisté ?
3. **Privy** : les org wallets supportent-ils une chaîne EVM arbitraire par chain ID, et le
   quorum m-sur-n est-il natif ?

**Les réponses déterminent l'architecture.** Si (1) est non → repositionner sur un autre sponsor
ou assumer un mock documenté. Si (2) est non → `MockFxVenue` devient la voie principale.
Si (3) est non → le quorum passe dans le contrat.

### 13.2 Découpage

| Lot | Contenu | Dépendances |
|---|---|---|
| L1 | Générateur de flux + calibration + harness de backtest | aucune |
| L2 | Moteur quantitatif (prévision, Σ, VaR/ES, résolution des bandes, objectif) | L1 |
| L3 | Contrats + tests (policy, verifier, vault, router, breaker) | aucune |
| L4 | Handler CRE + chiffrement + vérification d'attestation | L2, L3, jalon 0 |
| L5 | Adaptateurs venue (mock + Arc) | L3, jalon 0 |
| L6 | Privy : rôles, policies, flux d'approbation | L3 |
| L7 | Dashboard + visualisation du backtest | L1, L2 |
| L8 | Démo, vidéo, README, diagramme d'architecture, FEEDBACK | tout |

**Chemin critique : L2 → L4.** Le moteur quantitatif doit être terminé et testé avant de tenter
le portage dans le TEE, sinon on débogue deux problèmes à la fois dans l'environnement le plus
contraint.

**Règle de coupe** : si le temps manque, on sacrifie dans cet ordre — les transferts confidentiels,
la 4ᵉ devise, la FHS, le parcours de crise. On ne sacrifie **jamais** le backtest comparatif :
c'est le seul livrable qui prouve la thèse.

---

## 14. Décisions arrêtées

Critère d'arbitrage retenu : **maximiser la densité technique défendable par unité de temps**.
Une décision gagne si (a) elle produit un artefact qu'un ingénieur senior reconnaît comme non
trivial, (b) elle reste livrable en trois jours, (c) elle réduit une dépendance externe plutôt
que d'en créer une.

| # | Décision arrêtée | Justification |
|---|---|---|
| **D1** | **NEAP** — *Intraday Treasury Engine* | « le float » est le terme exact du métier pour le capital immobilisé en transit ; lisible par un trésorier comme par un juge crypto. Le nom énonce le problème, pas la solution. |
| **D2** | **Posture hybride** : 3 devises stablecoin (USD/EUR/GBP) + 1 corridor « rail lent » sans stablecoin (EUR→BRL), modélisé avec coût fixe élevé et latence J+2 | c'est le seul cadrage qui crée un **arbitrage entre deux régimes de coût**. Sans lui, le modèle n'a qu'un seul rail et l'optimiseur n'optimise rien d'intéressant. C'est aussi la situation réelle d'une trésorerie en transition — donc l'angle portfolio. |
| **D3** | **Résolution numérique** des bandes (Monte-Carlo + recherche directe), **warm-startée par la solution analytique de Miller-Orr**, qui sert aussi de test de non-régression sur le cas drift nul | le warm start rend la recherche rapide *et* démontre qu'on sait où le modèle fermé est valide. Deux signaux de compétence pour un seul composant. |
| **D4** | **ES 97.5 % (aligné FRTB) estimée par Filtered Historical Simulation**, avec ES normale en benchmark et VaR 99 % en affichage | FRTB a remplacé la VaR par l'ES 97.5 % précisément pour les raisons de §4.4. Citer la norme et l'implémenter coûte ~30 lignes (standardisation des résidus par la vol EWMA, rééchantillonnage, remise à l'échelle). **Le tableau comparatif des trois estimateurs est le meilleur artefact portfolio du projet.** |
| **D5** | **Frontière de confidentialité : le TEE ne calcule que ce qui dépend de l'état.** Tout ce qui ne dépend que des paramètres (bandes, σ, Σ, η) est calculé hors TEE et **engagé on-chain par hash** | règle simple, énonçable en une phrase, et vérifiable. Les bandes sont une fonction des paramètres statistiques, pas des soldes ; les soldes ne sortent jamais de l'enclave. Le `bandParamsHash` lie le rapport TEE à un jeu de paramètres auditable. |
| **D6** | **Commitment + quantification en lots de 100 k + jitter temporel** sur le déclenchement. Transferts confidentiels Arc en objectif secondaire. Fuite résiduelle documentée. | protection réelle et implémentable ; la documentation honnête de la fuite résiduelle vaut plus qu'une protection surjouée. |
| **D7** | **Le contrat fait autorité.** `TreasuryPolicy` porte les rôles, la séparation des devoirs et le seuil d'auto-approbation on-chain. Privy fournit la custody, les policies en défense en profondeur, et l'UX. | ⚡ **décision la plus structurante.** Elle supprime la dépendance à un éventuel quorum natif Privy, rend le modèle d'autorisation *vérifiable* plutôt que contractuel, et — point critique — donne au smart contract une responsabilité substantielle, ce qui neutralise le risque §3.1 (« contrat décoratif »). |
| **D8** | `IFxVenue` avec **`MockFxVenue` comme venue de référence** (carnet paramétrable, rejouable, déterministe) et `ArcFxVenue` comme intégration réelle | ce n'est pas un repli : le backtest **exige** un venue déterministe. Le mock est un livrable nécessaire, l'adaptateur Arc est la preuve d'intégration. La dépendance au jalon 0 disparaît. |
| **D9** | **Le moteur de risque est une fonction pure**, sans I/O, compilée une fois et exécutée soit dans le handler CRE, soit dans un runner local isolé, avec des entrées/sorties identiques. `ReportVerifier` vérifie l'attestation via un `IAttestationVerifier` interchangeable. | même code, deux hôtes : le plan B ne coûte rien parce qu'il est la même chose. On tente le déploiement CRE réel ; s'il est inaccessible, on livre l'attestation simulée en le documentant. |
| **D10** *(nouveau)* | **Protocole de backtest walk-forward, sans look-ahead, sur 20 seeds, avec intervalles de confiance** | ⚡ **le différenciateur portfolio.** Calibrer sur `[0,t)` et décider en `t` élimine le biais d'anticipation ; rapporter « −37 % ± 4 % » plutôt que « −41 % » est le geste qui sépare un ingénieur d'un auteur de démo. Coût marginal : quelques heures. |

### 14.1 Ce que ces choix impliquent, ensemble

Trois d'entre eux se renforcent et forment la colonne vertébrale défendable du projet :

- **D7** rend le contrat substantiel → le projet n'est pas « un dashboard avec un `emit` ».
- **D5** rend la confidentialité énonçable en une phrase → le juge Chainlink comprend en 10 secondes.
- **D4 + D10** rendent les chiffres crédibles → le juge quantitatif ne peut pas les démonter.

Et deux d'entre eux **suppriment les dépendances bloquantes** identifiées au §13.1 : D8 neutralise
le risque d'accès au RFQ Arc, D9 neutralise le risque d'indisponibilité du TEE. Les questions du
jalon 0 restent à poser, mais **aucune réponse négative ne tue plus le projet**. C'est le vrai
gain de cette session d'arbitrage.

---

## 15. Modèle de données

### 15.1 Entités off-chain

```
Corridor        { id, base, quote, rail: FAST|SLOW, gammaFixed, latencySec, etaImpact,
                  maxDepth }
FlowEvent       { ts, corridorId, direction: IN|OUT, amount, currency }
Commitment      { id, currency, amount, dueTs, certainty }   // engagements connus à venir
BalanceSnapshot { ts, currency → amount, source: CHAIN|LEDGER }
MarketTick      { ts, pair, mid, source: DATA_STREAM|ECB|RFQ }
BandSet         { paramsHash, currency → { L, Z, H }, solvedAt, method: ANALYTIC|NUMERIC }
EpochDecision   { epoch, inputsHash, bandParamsHash, riskMetrics, plan, commitment,
                  status, txHash }
BacktestRun     { seed, policy, params, metrics, walkForwardWindows }
```

`Commitment.certainty` mérite un mot : un paiement de paie programmé est certain, un flux prévu
est probabiliste. Les deux n'entrent pas de la même façon dans le calcul de buffer — le premier
réduit le solde disponible, le second n'affecte que la distribution. Confondre les deux est une
erreur classique de moteur de trésorerie.

### 15.2 Structures on-chain

```solidity
struct CurrencyPolicy {
    uint128 lowerBand;         // L   (unités natives du token, 6 décimales)
    uint128 target;            // Z*
    uint128 upperBand;         // H
    uint128 maxSingleOrder;
    uint128 maxPerEpoch;
    uint128 maxRolling24h;
}

struct RiskParams {
    uint32  kappaBps;              // aversion au risque
    uint32  hDepegBps;             // haircut basis stablecoin  (§1.5)
    uint32  maxExecDeviationBps;   // contrôle de déviation RFQ vs oracle
    uint32  maxStalenessSec;
    uint32  minEpochIntervalSec;   // cooldown anti-grief
    uint128 autoApproveThreshold;
}

struct RebalanceReport {
    uint64  epoch;
    uint64  nonce;
    uint64  expiry;
    uint32  policyVersion;
    bytes32 bandParamsHash;    // lie le rapport aux paramètres hors-TEE (D5)
    bytes32 inputsHash;        // hash des inputs publics : fx, gas, quotes
    bytes32 ordersCommitment;  // keccak(abi.encode(orders, salt))        (D6)
    int32   varBeforeBps;      // métriques agrégées, quantifiées
    int32   varAfterBps;
    uint128 costEstimate;
    bytes   attestation;
}
```

Note de conception : les métriques de risque sont publiées **en points de base relatifs**, jamais
en montant absolu — c'est une conséquence directe de D6, et ça se voit dans le type (`int32` et
non `uint256`).

---

## 16. Interfaces des contrats

### 16.1 `TreasuryPolicy` — l'autorité (D7)

```solidity
bytes32 constant RISK_OFFICER = keccak256("RISK_OFFICER");
bytes32 constant TREASURER    = keccak256("TREASURER");
bytes32 constant OPERATOR     = keccak256("OPERATOR");
bytes32 constant GUARDIAN     = keccak256("GUARDIAN");

function proposePolicy(address token, CurrencyPolicy calldata p) external;  // RISK_OFFICER
function commitPolicy(uint32 version) external;                             // après timelock
function setRiskParams(RiskParams calldata r) external;                     // RISK_OFFICER + timelock
function commitBandParams(bytes32 paramsHash) external;                     // RISK_OFFICER  (D5)
function pause() external;                                                  // GUARDIAN, sans timelock
```

**Invariant de séparation des devoirs, vérifié on-chain :** aucune adresse ne peut détenir
simultanément `RISK_OFFICER` et `TREASURER`. C'est un `require` dans `_grantRole`, pas une règle
d'UI. C'est ce qui donne son sens à D7 et c'est **le premier test unitaire à écrire**.

Timelock : 24 h nominal, réduit à 60 s via une constante de build en mode démo — et le mode démo
est visible à l'écran, pour que personne ne croie que le timelock est cosmétique.

### 16.2 `ReportVerifier`

```solidity
function verify(RebalanceReport calldata r, bytes calldata donSig)
    external returns (bytes32 reportId);
```

Contrôles, dans l'ordre (le moins cher d'abord) :
1. `!paused`
2. `r.expiry > block.timestamp` et `r.epoch > lastEpoch + minEpochInterval`
3. `r.policyVersion == currentVersion` et `r.bandParamsHash == committedBandParamsHash`
4. `nonce` non consommé → consommé atomiquement
5. signature DON valide sur `keccak(abi.encode(r))`
6. `IAttestationVerifier.verify(r.attestation, expectedMeasurement)` — adaptateur interchangeable (D9)

`reportId = keccak256(policyVersion, epoch, nonce, ordersCommitment)` — **la clé d'idempotence**.

### 16.3 `RebalanceVault`

```solidity
function submit(RebalanceReport calldata r, bytes calldata sig) external;    // OPERATOR
function approve(bytes32 reportId) external;                                 // TREASURER
function execute(bytes32 reportId, Order[] calldata orders, bytes32 salt)
    external nonReentrant;                                                   // OPERATOR
```

`execute` :
1. état == `VERIFIED` (≤ seuil) ou `APPROVED` (> seuil)
2. `keccak(abi.encode(orders, salt)) == ordersCommitment` — révélation du commitment (D6)
3. **bornes de sanité indépendantes du rapport** : chaque ordre ≤ `maxSingleOrder`, somme de
   l'epoch ≤ `maxPerEpoch`, fenêtre glissante 24 h ≤ `maxRolling24h`
4. pour chaque ordre : `router.quote()` → contrôle de déviation vs oracle → `router.settlePvP()`
5. comptabilisation, `emit Rebalanced(...)`, transition d'état

Le point 3 est essentiel : **le contrat ne fait jamais confiance au rapport**. Si le modèle
déraille (volatilité estimée nulle, division par zéro, calibration corrompue), les bornes
contiennent les dégâts. C'est la différence entre un système et un script.

### 16.4 `IFxVenue` (D8)

```solidity
interface IFxVenue {
    function quote(address tokenIn, address tokenOut, uint256 amountIn)
        external view returns (uint256 amountOut, uint64 quoteExpiry, bytes32 quoteId);

    function settlePvP(bytes32 quoteId, uint256 amountIn, uint256 minAmountOut, address to)
        external returns (uint256 amountOut);
}
```

`MockFxVenue` : carnet paramétrable (profondeur, η, spread), déterministe pour un seed donné —
c'est le venue du backtest. `ArcFxVenue` : adaptateur vers le RFQ natif.

Le fait que le backtest et la production partagent la **même interface** est un point de design
à mettre en avant : la politique testée est littéralement la politique exécutée.

### 16.5 Machine à états et transitions autorisées

```
                submit            approve           execute
   (néant) ──────────────> VERIFIED ────────> APPROVED ────────> SETTLED
                              │  └──────── execute (si ≤ seuil) ─────┘
                              │
                          EXPIRED  (expiry dépassée)
                              │
                           FAILED ──compensate──> COMPENSATED
```

⚠️ `COMPENSATED` n'existe que si le PvP d'Arc n'est **pas** atomique du point de vue de l'appelant.
À vérifier au jalon 0 ; si le PvP est atomique, cet état disparaît et la machine se simplifie.

---

## 17. Calibration du générateur de flux

### 17.1 Structure

```
Arrivées   N_t ~ Poisson( λ_c · s_hour(t) · s_dow(t) · s_dom(t) )
Montants   X_i ~ LogNormal(μ_c, σ_c)
Flux net   F_t = Σ IN − Σ OUT
```

| Paramètre | Valeur initiale | Source de calibration | Confiance |
|---|---|---|---|
| `λ_EUR/USD` | ~ volume quotidien du corridor / taille moyenne | statistiques SEPA de la BCE | moyenne |
| `s_hour` | profil bimodal, creux nocturne | profils de paiement de détail publiés | moyenne |
| `s_dow` | creux week-end (−60 %) | idem | bonne |
| `s_dom` | pics au 1ᵉʳ et en fin de mois (paie) | idem | bonne |
| `μ_c, σ_c` | log-normale, queue épaisse | corridors de remittance Banque Mondiale | moyenne |
| `drift` par corridor | déficitaire pour EUR→BRL | structure des flux de remittance | bonne |

### 17.2 Test de validité du générateur

Le générateur n'est défendable que s'il est **testé**. Suite de tests à écrire :

1. moyenne et variance du flux journalier à ±10 % des agrégats publics ;
2. profil hebdomadaire : ratio week-end/semaine dans la fourchette cible ;
3. autocorrélation à lag 1 jour et lag 7 jours dans la fourchette cible ;
4. kurtosis des montants > 3 (la queue épaisse doit exister, sinon la VaR est fausse) ;
5. reproductibilité : même seed → hash de sortie identique.

**Le test 5 est celui qu'un juge peut vérifier en 10 secondes**, et c'est celui qui rend tous
les autres crédibles.

### 17.3 Coûts

| Grandeur | Rail FAST (Arc) | Rail SLOW (correspondant) |
|---|---|---|
| Coût fixe γ | gas USDC, ordre du cent | frais de virement, ordre de plusieurs dizaines de dollars |
| Latence | ~350 ms | J+1 à J+2 |
| Spread | RFQ, à mesurer | spread bancaire, plus large |
| Impact η | non calibrable (§4.6), exposé en paramètre | non applicable (prix négocié) |

Le ratio des γ entre les deux rails est de l'ordre de 10³–10⁴. **C'est ce ratio qui produit
l'effondrement du buffer annoncé en §1.2, et c'est la seule quantité vraiment structurante du
modèle.** Toute la démo doit tourner autour de lui.

---

## 18. Protocole de backtest (D10)

### 18.1 Walk-forward, sans anticipation

```
Pour chaque fenêtre w = 1..W :
    calibration (σ, Σ, λ, μ, bandes)  sur  [t0, t_w)        ← passé strict
    simulation de la politique        sur  [t_w, t_{w+1})   ← futur non vu
    accumulation des métriques
```

Aucun paramètre utilisé à l'instant `t` ne peut avoir été estimé avec une donnée postérieure à
`t`. C'est une contrainte simple à énoncer et facile à violer par inadvertance — d'où un test
dédié : un « canari » de look-ahead, une série injectée dont une valeur future extrême ne doit
avoir aucun effet sur les décisions antérieures.

### 18.2 Politiques comparées

| Politique | Description | Rôle |
|---|---|---|
| `STATIC` | buffer fixe dimensionné au pire flux observé | témoin haut — l'état de l'art actuel |
| `CALENDAR` | rééquilibrage en fin de journée, cible fixe | témoin réaliste — ce que fait une trésorerie |
| `NEAP` | bandes optimisées, déclenchement par signal | le sujet |
| `ORACLE` | politique optimale avec connaissance parfaite du futur | **borne supérieure** |

⚡ La politique `ORACLE` est le raffinement qui coûte le moins cher et impressionne le plus :
elle donne la performance maximale atteignable, et permet de dire « NEAP capture 78 % du gain
théoriquement disponible » plutôt qu'un pourcentage sans référentiel. **C'est une phrase qu'aucun
autre projet du hackathon ne pourra prononcer.**

### 18.3 Métriques rapportées

Sur 20 seeds, moyenne et intervalle de confiance à 95 % :

| Métrique | Sens |
|---|---|
| capital moyen immobilisé | l'objectif principal |
| ES 97.5 % moyenne du portefeuille | le risque porté |
| coûts d'exécution cumulés | **doit augmenter** — c'est l'arbitrage |
| nombre de ruptures de seuil | contrainte dure : doit rester à 0 |
| nombre de rééquilibrages | mesure d'activité, détecte le sur-trading |
| fraction du gain `ORACLE` capturée | la mesure honnête de la performance |

Un tableau à six lignes avec des intervalles de confiance. Rien de spectaculaire visuellement,
et c'est exactement pour cette raison qu'il est convaincant.
