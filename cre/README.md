# L4 — handler confidentiel Chainlink CRE

## État

| Pièce | Statut |
|---|---|
| `handler/types.ts` — contrat de données, frontière de confidentialité | ✅ |
| `handler/buildReport.ts` — état de trésorerie → rapport signable | ✅ 14 tests |
| Enveloppe SDK (`handlerInTee`, secrets, HTTP) | ⏳ attend l'installation de la CLI |
| `cre workflow simulate` | ⏳ |

Le cœur ne connaît pas le SDK : il prend un état, rend un rapport, donc il se teste sans
enclave, sans réseau et sans chaîne. C'est la conséquence de D9 — le moteur est une
fonction pure, et cet adaptateur l'est aussi. L'enveloppe CRE se réduira à trois gestes :
récupérer un secret, faire deux appels HTTP, appeler `buildReport`.

## Prérequis d'installation

```bash
brew install bun
curl -sSL https://app.chain.link/cre/install.sh | bash
```

Le SDK `@chainlink/cre-sdk` sera installé dans ce dossier uniquement. C'est la première
dépendance JavaScript du dépôt, et elle est confinée ici : `data/`, `engine/` et `app/`
restent sans dépendance.

## Forme visée

```ts
cre.handlerInTee(
  cronTrigger,
  async (runtime: TeeRuntime) => {
    const token = await runtime.getSecret({ id: 'TREASURY_API_TOKEN' })
    const seed  = await runtime.getSecret({ id: 'COMMITMENT_SALT_SEED' })

    const treasury = await fetchTreasury(runtime, token)   // confidentiel
    const market   = await fetchMarket(runtime)            // public

    const out = buildReport({ treasury, market, chain: CHAIN, saltSeed: seed, now })

    return runtime.usingTheDons(() => out.report)          // seul le rapport ressort
  },
  [{ tee: 'nitro', regions: ['us-west-2'] }],
)
```

## Contraintes de la plateforme

- **11 secrets et 5 appels HTTP** au maximum par invocation. FLOAT en utilise deux et
  deux — large marge.
- **La logique du workflow n'est pas confidentielle**, seules les données le sont. C'est
  exactement ce que FLOAT demande : on protège les positions, pas le modèle. À dire avant
  qu'un juge ne le demande.
- L'attestation est vérifiée par le **consensus du DON**, pas par le contrat consommateur
  (D23).

## Ce qui est protégé, et pourquoi

Soldes vivants par devise, engagements connus à venir, limites internes. Pris séparément,
chacun est anodin. Publiés ensemble, ils dressent une carte complète de la position de
liquidité de l'institution — de quoi se positionner contre elle. C'est cette conjonction
qui justifie l'enclave, et c'est ce que dit la demande d'accès (`docs/CRE-ACCESS-FORM.md`).

Restent dehors : taux de change, gaz, cotations indicatives. Délimiter le périmètre plutôt
que tout mettre dans l'enclave par précaution est aussi une façon de montrer qu'on en
connaît le coût.
