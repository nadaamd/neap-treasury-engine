# Journal des décisions d'architecture

Format court : décision, raison, conséquence. Le détail vit dans `SPEC.md` §14.

| # | Décision | Raison en une ligne |
|---|---|---|
| D1 | Nom : **FLOAT** | « le float » est le terme métier exact du capital immobilisé en transit |
| D2 | Périmètre **hybride** : 3 devises stablecoin + 1 corridor « rail lent » | crée l'arbitrage entre deux régimes de coût fixe — sans lui l'optimiseur n'optimise rien |
| D3 | Bandes par **résolution numérique warm-startée** par Miller-Orr analytique | rapide, général, et Miller-Orr sert de test de non-régression |
| D4 | **ES 97.5 % (FRTB) par Filtered Historical Simulation** | la VaR normale sous-estime la queue ; FRTB a fait ce choix pour la même raison |
| D5 | **Le TEE ne calcule que ce qui dépend de l'état** ; les paramètres sont engagés on-chain par hash | frontière de confidentialité énonçable en une phrase et vérifiable |
| D6 | Commitment + quantification en lots + jitter | protège le montant sans surjouer ; fuite résiduelle documentée |
| D7 | **Le contrat fait autorité** sur les rôles ; Privy = custody + UX | rend l'autorisation vérifiable et le contrat substantiel |
| D8 | `IFxVenue` : `MockFxVenue` de référence, `ArcFxVenue` en intégration | le mock est requis par le backtest de toute façon — pas un repli |
| D9 | Moteur de risque = **fonction pure**, deux hôtes possibles | le plan B ne coûte rien parce qu'il est le même code |
| D10 | Backtest **walk-forward, 20 seeds, IC 95 %**, + politique `ORACLE` de référence | supprime le biais d'anticipation et donne un référentiel au gain annoncé |
| D11 | **TypeScript** pour le moteur ; Python réservé à l'exploration de calibration | la fonction pure doit être portable dans le handler CRE et réutilisable par le dashboard (D9) |
| D12 | **Epoch de 15 minutes justifié quantitativement**, plus par convention | le modèle de bandes exige que le choc de flux d'une période soit petit devant la largeur de bande ; à granularité journalière le choc EUR vaut ±1,5 M$ contre une bande de 100 k$, et la politique dégénère |
| D13 | **Le coût de rupture est tarifé en espérance analytique, pas compté en simulation** | la probabilité de rupture à l'optimum est de l'ordre de 10⁻⁵ à 10⁻⁸ ; 120 000 périodes simulées ne la mesurent pas, donc le terme et son gradient valaient zéro partout |
| D14 | **Le coût de rupture est une grandeur absolue**, pas un multiple de γ | la spec proposait c_b = 250·γ ; quand γ s'effondre d'un facteur 10⁴ en passant au rail rapide, c_b s'effondrerait avec lui — or une rupture de paiement coûte la même chose quel que soit le rail utilisé pour la corriger |

| D15 | **Séquence croissante sur le couple (epoch, nonce)**, pas sur l'epoch seul | le parcours de crise (§2.3) exige un rapport hors cycle entre deux epochs ; la stricte croissance de l'epoch l'interdirait |
| D16 | **Le contrôle d'idempotence passe avant le contrôle de séquence** | un rejeu doit échouer pour la bonne raison ; un rejet incident par le contrôle de séquence masquerait la vraie garantie |

## Décisions encore ouvertes

- Existence de l'état `COMPENSATED` → dépend de l'atomicité du PvP Arc (jalon 0)
