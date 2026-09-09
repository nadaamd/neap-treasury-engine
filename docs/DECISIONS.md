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

## Décisions encore ouvertes

- Existence de l'état `COMPENSATED` → dépend de l'atomicité du PvP Arc (jalon 0)
