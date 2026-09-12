# Journal des décisions d'architecture

Format court : décision, raison, conséquence. Le détail vit dans `SPEC.md` §14.

| # | Décision | Raison en une ligne |
|---|---|---|
| D1 | Nom : **NEAP** | « le float » est le terme métier exact du capital immobilisé en transit |
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

| D17 | **Fenêtre réellement glissante** (24 seaux horaires) plutôt qu'à remise périodique | une fenêtre à remise laisse passer deux fois la limite de part et d'autre d'une frontière — un trou de trop pour une contrainte censée borner un opérateur compromis |
| D18 | **`grossNotional` publié en clair dans le rapport**, par exception au principe des grandeurs relatives | le seuil d'approbation porte sur la taille du plan, or les ordres sont scellés jusqu'à l'exécution ; sans ce champ le trésorier approuverait à l'aveugle, ce qui ne serait pas une approbation. La décomposition, elle, reste protégée |
| D19 | **Un plan est atomique** : un ordre qui échoue fait échouer tout le plan | exécuter partiellement — vendre l'euro sans acheter la livre prévue — laisserait une position que personne n'a décidée, pire que l'inaction |

| D20 | **L'état `COMPENSATED` est supprimé** de la machine à états du coffre | le PvP de StableFX est documenté atomique : « both sides complete or neither does ». La question du jalon 0 avait une réponse publique |
| D21 | **`ArcFxVenue` n'est pas un contrat on-chain** mais un adaptateur hors chaîne (RFQ par API → intention en données typées → règlement Permit2) | StableFX est une intégration API/SDK : « you don't need to interact with smart contracts directly ». L'interface `IFxVenue` reste juste pour le mock et pour tout lieu réellement on-chain, mais elle ne décrit pas StableFX |
| D22 | **La cible de L4 est `cre workflow simulate`**, un déploiement testnet restant un bonus | le simulateur local ne demande aucune inscription, et le track ETHGlobal accepte explicitement « successful simulation ». L'inscription en bêta ouvre 90 jours de testnet — utile mais pas sur le chemin critique à trois jours |
| D23 | **L'attestation est vérifiée par le consensus du DON**, pas par le contrat | « DON consensus verifies attestations from the enclave ». `IAttestationVerifier` reste un point d'extension honnête, mais le modèle de confiance réel doit être énoncé tel qu'il est |

| D24 | **Les mocks ne partent jamais sur mainnet ; le profil mainnet déploie `PausedFxVenue` et met le système en pause** | sur mainnet USDC et EURC sont réels : un lieu factice y serait incapable de sourcer la moindre liquidité et prendrait l'apparence d'un piège si quelqu'un l'alimentait. Un refus explicite dit la vérité — déployé, vérifiable, prouvablement inopérant. Et ces contrats ne sont pas audités : les déployer est acceptable, y placer des fonds ne l'est pas |

## Décisions encore ouvertes

- Chaînes de destination supportées par CRE, et support d'Arc en particulier
