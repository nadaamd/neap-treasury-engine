# Obligation de déploiement mainnet — Arc

> Règle du sponsor : tout projet primé doit être déployé sur mainnet **avant le
> 30 septembre 2026**. Pendant le hackathon, le testnet suffit. L'équipe Arc accompagne
> le passage après l'événement.

## Le calendrier, qui est serré des deux côtés

| Date | Événement |
|---|---|
| 10 septembre 2026 | aujourd'hui — le mainnet Arc **n'existe pas encore** |
| 16 septembre 2026 | ouverture du mainnet public ; Circle publie alors chain ID, RPC et explorateur |
| 30 septembre 2026 | date limite de déploiement mainnet en cas de prix |

La fenêtre utile fait donc **quatorze jours**, et elle commence après la fin du hackathon.
Rien de ce qui suit n'est sur le chemin critique de la soumission — mais s'engager sur un
prix Arc, c'est s'engager sur cette fenêtre.

## Réseaux

| | Testnet | Mainnet |
|---|---|---|
| Chain ID | 5042002 | non publié à ce jour (5042 selon des sources tierces) |
| RPC | publié | publié le 16 septembre |
| Explorateur | testnet.arcscan.app | publié le 16 septembre |
| Gaz | parrainé par la Gas Station de Circle, ou faucet | **USDC réel**, à ponter via CCTP |

Le jeu de validateurs est permissionné — onze institutions choisies par Circle — mais rien
dans la documentation n'indique que le **déploiement de contrats** le soit. C'est à
vérifier le 16, et c'est le seul point qui pourrait tout changer.

## Ce qu'on déploiera, et ce qu'on ne déploiera pas

C'est ici que la règle a une conséquence architecturale, et il faut la prendre au sérieux
plutôt que d'y voir une formalité.

**Ne partent pas sur mainnet : `MockERC20` et `MockFxVenue`.** Sur mainnet, l'USDC et
l'EURC sont de vrais jetons. Un lieu d'exécution factice y serait un contrat incapable de
sourcer la moindre liquidité, et qui prendrait l'apparence d'un piège si quelqu'un
l'alimentait. Le mock est un instrument de backtest et de démonstration, pas un artefact
de production.

**Partent sur mainnet** : `TreasuryPolicy`, `ReportVerifier`, `RebalanceVault` et un lieu
d'exécution explicite.

**Le lieu d'exécution mainnet est le point dur.** StableFX est une intégration API
réservée aux institutions vérifiées, et son adaptateur vit hors chaîne (D21). Tant que
l'accès n'est pas accordé, le coffre déployé sur mainnet n'a pas de contrepartie
crédible. On déploie donc `PausedFxVenue` — un lieu qui refuse toute exécution avec une
erreur explicite. Le système est déployé, vérifiable et **prouvablement inopérant**
jusqu'à ce qu'un administrateur y branche un vrai lieu par `setVenue`.

Dire « déployé et volontairement inerte » est honnête. Déployer un mock sur mainnet en
laissant croire qu'il exécute ne l'est pas.

## Règle de sécurité, non négociable

**Ces contrats ne sont pas audités.** Les déployer sur mainnet est acceptable ; y placer
des fonds réels ne l'est pas. Le déploiement mainnet est un déploiement, pas une mise en
exploitation :

- le coffre part **en pause** (`GUARDIAN.pause()` dans la foulée du déploiement) ;
- aucun jeton n'y est transféré ;
- les limites par devise restent à zéro tant qu'aucune politique n'est appliquée.

Un projet de hackathon qui déploie sur mainnet et y met de l'argent parce qu'une règle de
concours l'y pousse commet exactement l'erreur que le reste de ce dépôt s'emploie à
éviter.

## À prévoir côté opérationnel

- **De l'USDC réel sur Arc mainnet** pour le gaz. Le déploiement de quatre contrats plus
  un lieu inerte reste de l'ordre de quelques dollars, mais ce n'est pas zéro, et il faut
  ponter via CCTP.
- Une clé de déploiement distincte de toute clé personnelle.
- La vérification du code source sur l'explorateur, dès qu'il est publié.

## Ce qui est prêt

Le script de déploiement gère trois profils depuis la même source — `anvil` pour le
scénario de bout en bout, `arc-testnet` pour la démonstration, `arc-mainnet` pour
l'obligation post-hackathon. Les mocks ne sont instanciés que sur les deux premiers, et
c'est le script lui-même qui le garantit, pas une consigne.
