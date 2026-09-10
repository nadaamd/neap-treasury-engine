# L6 — gouvernance opérationnelle, org wallets Privy

## Pourquoi deux couches de contrôle

La séparation des devoirs est déjà imposée on-chain (D7) : `TreasuryPolicy` refuse qu'une
même adresse détienne à la fois `RISK_OFFICER` et `TREASURER`, et le coffre refuse une
exécution non approuvée. Alors pourquoi la redire côté portefeuille ?

**Parce que les deux couches échouent différemment.**

| | Ce que ça protège | Ce que ça ne voit pas |
|---|---|---|
| Contrat | qui a le droit de faire quoi, dans quelles limites de montant | une transaction qui ne lui est pas adressée |
| Politique Privy | quelles transactions cette clé peut signer, tout court | la cohérence métier d'un appel autorisé |

Une clé compromise passe l'authentification. Elle peut signer un transfert vers une
adresse arbitraire, appeler un contrat étranger, vider un solde — et le contrat n'en
saura jamais rien, parce que ces transactions ne passent pas par lui. Une politique qui
n'autorise que trois sélecteurs vers deux adresses, elle, les refuse.

Aucune des deux couches ne remplace l'autre.

## Ce que chaque rôle peut signer

| Rôle | Destination | Fonctions | Quorum |
|---|---|---|---|
| `OPERATOR` | coffre | `submit`, `execute` | 1 / 1 |
| `TREASURER` | coffre | `approve` | **2 / 3** |
| `RISK_OFFICER` | politique | `queueCurrencyPolicy`, `queueRiskParams`, `commitBandParams` | 1 / 2 |

Chaque politique ajoute une troisième condition qu'on oublie facilement : **valeur native
strictement nulle**. Un portefeuille autorisé à *appeler* un contrat reste autorisé à lui
*envoyer* de la valeur — et sur Arc, le gaz est de l'USDC, donc la valeur native est de
l'argent.

Chaque politique se termine par un refus explicite sans condition. Une liste
d'autorisations sans refus final dépend de l'ordre d'évaluation du moteur, et mieux vaut
ne pas en dépendre.

Un seul rôle exige plusieurs signatures : le trésorier. C'est le geste le plus lourd de
conséquences du système. Un quorum sur l'opérateur alourdirait chaque epoch de quinze
minutes sans rien protéger que le contrat ne protège déjà.

## Sélecteurs, vérifiés dans les deux sens

Les sélecteurs autorisés sont calculés en TypeScript avec notre propre keccak256, puis
**confrontés au bytecode compilé** par la suite Solidity de conformité. Une signature mal
recopiée produirait une politique qui bloque exactement ce qu'elle devait permettre — et
l'erreur ne se verrait qu'au moment d'une approbation refusée en pleine démonstration.

```
0x6d7885e8  OPERATOR      submit(...)
0xfc8d9160  OPERATOR      execute(...)
0xa53a1adf  TREASURER     approve(bytes32)
0x984103d1  RISK_OFFICER  queueCurrencyPolicy(...)
0x5eb8879d  RISK_OFFICER  queueRiskParams(...)
0x97b00759  RISK_OFFICER  commitBandParams(bytes32)
```

## Provisionner

```bash
cp privy/.env.example privy/.env   # renseigner PRIVY_APP_ID et PRIVY_APP_SECRET
node privy/scripts/provision.ts <adresse-coffre> <adresse-treasury-policy>
```

Le script crée une politique et un portefeuille par rôle, puis écrit `privy/wallets.json`.
Il échoue bruyamment si ce fichier existe déjà, plutôt que de créer des doublons
silencieux.

Étape suivante, à faire sciemment : attribuer les rôles on-chain à ces adresses via
`TreasuryPolicy.grantRole`. Le contrat refusera d'attribuer `RISK_OFFICER` et `TREASURER`
à la même adresse — c'est l'invariant, et il s'applique aussi aux portefeuilles Privy.

## Point à confirmer au premier provisionnement

La documentation établit l'existence de `field_source: 'ethereum_calldata'` et
l'obligation de fournir une ABI, sans figer le nom du champ portant la fonction appelée.
Il est isolé dans une seule constante, `CALLDATA_FUNCTION_FIELD`. Si l'API le refuse,
elle le dira, et une seule ligne changera.
