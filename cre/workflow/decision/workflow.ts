/**
 * FLOAT — décision de rééquilibrage exécutée dans une enclave.
 *
 * Ce fichier ne contient aucune logique métier. Elle vit dans `buildReport`, une
 * fonction pure testée sans enclave, sans réseau et sans chaîne. Ici on ne fait que
 * trois choses : chercher deux secrets, faire deux appels HTTP, publier un rapport.
 *
 * ─── Ce que l'enclave protège, et ce qu'elle ne protège pas ───────────────────
 * Le binaire du workflow — donc cette logique — est fourni à l'enclave par le Workflow
 * DON et n'est **pas** confidentiel. Ce qui l'est : les secrets du Vault DON, les
 * charges utiles des requêtes et réponses HTTP émises depuis l'enclave, et les valeurs
 * intermédiaires.
 *
 * C'est exactement ce dont FLOAT a besoin. Le modèle n'a aucune raison d'être secret —
 * il est même publié dans la spec. Ce qui doit le rester, ce sont les soldes vivants par
 * devise, les engagements connus à venir et les limites internes. Pris séparément, chacun
 * est anodin ; publiés ensemble, ils dressent une carte de la position de liquidité
 * suffisante pour qu'une contrepartie s'y positionne contre.
 *
 * ─── Déterminisme ─────────────────────────────────────────────────────────────
 * Le résultat de l'enclave est attesté puis vérifié par consensus du DON : à entrées
 * identiques il doit produire une sortie identique. `buildReport` n'a ni horloge, ni
 * aléa, ni E/S — l'horodatage et la graine du sel lui sont passés en argument.
 */

import { cre, hexToBase64, ok, text, type TeeRuntime } from '@chainlink/cre-sdk'
import { encodeAbiParameters, parseAbiParameters } from 'viem'
import { z } from 'zod'

import { buildReport } from '../../handler/buildReport.ts'
import type { ChainConfig, MarketSnapshot, TreasurySnapshot } from '../../handler/types.ts'

// ─── Schéma de configuration ────────────────────────────────
export const configSchema = z.object({
	schedule: z.string(),
	treasuryUrl: z.string(),
	marketUrl: z.string(),
	treasuryTokenSecretId: z.string(),
	saltSeedSecretId: z.string(),
	numeraire: z.string(),
	currencies: z.array(z.string()),
	tokens: z.record(z.string()),
	decimals: z.number(),
	slippageBps: z.number(),
	validitySec: z.number(),
})
type Config = z.infer<typeof configSchema>

const httpGet = (runtime: TeeRuntime<Config>, url: string, bearer?: string): string => {
	const response = new cre.capabilities.HTTPClient()
		.sendRequest(runtime, {
			url,
			method: 'GET',
			...(bearer
				? { multiHeaders: { Authorization: { values: [`Bearer ${bearer}`] } } }
				: {}),
		})
		.result()

	if (!ok(response)) {
		throw new Error(`appel refusé (${response.statusCode}) : ${url}`)
	}
	return text(response)
}

// ─── Callback exécuté dans l'enclave ────────────────────────
export const onCronTrigger = (runtime: TeeRuntime<Config>): string => {
	const config = runtime.config

	// ── Secrets, déchiffrés dans l'enclave au moment où le code en a besoin ──
	const treasuryToken = runtime.getSecret({ id: config.treasuryTokenSecretId }).result().value
	const saltSeed = runtime.getSecret({ id: config.saltSeedSecretId }).result().value

	// ── Deux appels HTTP. La limite de la plateforme est de cinq. ──
	// Le premier rapporte l'état confidentiel : son en-tête porte le secret, et sa
	// réponse ne quitte jamais l'enclave.
	const treasury = JSON.parse(
		httpGet(runtime, config.treasuryUrl, treasuryToken),
	) as TreasurySnapshot
	// Le second ne rapporte que du public : taux, volatilité, gaz. Aucune raison de le
	// protéger, et protéger ce qui n'en a pas besoin coûte sans rien apporter.
	const market = JSON.parse(httpGet(runtime, config.marketUrl)) as MarketSnapshot

	const chain: ChainConfig = {
		numeraire: config.numeraire as ChainConfig['numeraire'],
		currencies: config.currencies as ChainConfig['currencies'],
		tokens: config.tokens,
		decimals: config.decimals,
		slippageBps: config.slippageBps,
		validitySec: config.validitySec,
	}

	const outcome = buildReport({
		treasury,
		market,
		chain,
		saltSeed,
		now: market.timestamp,
	})

	// ⚠️ À retirer avant tout déploiement : journaliser depuis l'enclave érode
	// précisément ce qu'elle protège. On ne trace ici qu'un statut, jamais un montant.
	runtime.log(`décision : ${outcome.status} — ${outcome.reason}`)

	if (outcome.status !== 'PROPOSE') {
		return `${outcome.status} : ${outcome.reason}`
	}

	// ── Retour vers le DON pour ce qui exige un consensus ──
	// Tout ce qui passe ici cesse d'être confidentiel. On ne fait traverser que le
	// rapport : un engagement sur les ordres, et des métriques en points de base. Ni le
	// plan, ni les soldes, ni les montants par devise.
	const donRuntime = runtime.usingTheDons()
	const r = outcome.report

	const encodedPayload = encodeAbiParameters(
		parseAbiParameters(
			'uint64 epoch, uint64 nonce, uint64 expiry, uint64 inputsTimestamp,' +
				'uint32 policyVersion, bytes32 bandParamsHash, bytes32 inputsHash,' +
				'bytes32 ordersCommitment, int32 esBeforeBps, int32 esAfterBps,' +
				'uint128 costEstimate, uint128 grossNotional',
		),
		[
			r.epoch,
			r.nonce,
			r.expiry,
			r.inputsTimestamp,
			Number(r.policyVersion),
			r.bandParamsHash as `0x${string}`,
			r.inputsHash as `0x${string}`,
			r.ordersCommitment as `0x${string}`,
			Number(r.esBeforeBps),
			Number(r.esAfterBps),
			r.costEstimate,
			r.grossNotional,
		],
	)

	donRuntime
		.report({
			encodedPayload: hexToBase64(encodedPayload),
			encoderName: 'evm',
			signingAlgo: 'ecdsa',
			hashingAlgo: 'keccak256',
		})
		.result()

	// Le plan en clair et son sel ne sont pas dans le rapport : ils restent à
	// l'opérateur, qui les révélera au coffre au moment d'exécuter (D6).
	return `PROPOSE — ${outcome.reveal.orders.length} ordre(s), engagement ${r.ordersCommitment.slice(0, 10)}…`
}

// ─── Initialisation ─────────────────────────────────────────
export function initWorkflow(config: Config) {
	const cronTrigger = new cre.capabilities.CronCapability()

	return [
		cre.handlerInTee(cronTrigger.trigger({ schedule: config.schedule }), onCronTrigger, [
			{ tee: 'nitro', regions: ['us-west-2'] },
		]),
	]
}
