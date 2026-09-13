/**
 * NEAP — the rebalancing decision, executed inside an enclave.
 *
 * This file contains no business logic. That lives in `buildReport`, a pure function
 * tested with no enclave, no network and no chain. Only three things happen here: fetch
 * two secrets, make two HTTP calls, publish a report.
 *
 * ─── What the enclave protects, and what it does not ──────────────────────────
 * The workflow binary — hence this logic — is supplied to the enclave by the Workflow DON
 * and is **not** confidential. What is: the Vault DON secrets, the payloads of HTTP
 * requests and responses issued from the enclave, and the intermediate values.
 *
 * That is exactly what NEAP needs. The model has no reason to be secret — it is even
 * published in the spec. What must stay secret are the live balances per currency, the
 * known upcoming commitments and the internal limits. Taken separately each is
 * innocuous; published together they draw a map of the liquidity position detailed
 * enough for a counterparty to trade against it.
 *
 * ─── Determinism ──────────────────────────────────────────────────────────────
 * The enclave's result is attested and then verified by DON consensus: on identical
 * inputs it must produce identical output. `buildReport` has no clock, no randomness and
 * no I/O — the timestamp and the salt seed are passed in as arguments.
 */

import { cre, hexToBase64, ok, text, type TeeRuntime } from '@chainlink/cre-sdk'
import { encodeAbiParameters, parseAbiParameters } from 'viem'
import { z } from 'zod'

import { buildReport } from '../../handler/buildReport.ts'
import type { ChainConfig, MarketSnapshot, TreasurySnapshot } from '../../handler/types.ts'

// ─── Configuration schema ───────────────────────────────────
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
		throw new Error(`call refused (${response.statusCode}): ${url}`)
	}
	return text(response)
}

// ─── Callback executed inside the enclave ───────────────────
export const onCronTrigger = (runtime: TeeRuntime<Config>): string => {
	const config = runtime.config

	// ── Secrets, decrypted inside the enclave at the moment the code needs them ──
	const treasuryToken = runtime.getSecret({ id: config.treasuryTokenSecretId }).result().value
	const saltSeed = runtime.getSecret({ id: config.saltSeedSecretId }).result().value

	// ── Two HTTP calls. The platform limit is five. ──
	// The first returns the confidential state: its header carries the secret, and its
	// response never leaves the enclave.
	const treasury = JSON.parse(
		httpGet(runtime, config.treasuryUrl, treasuryToken),
	) as TreasurySnapshot
	// The second returns only public data: rates, volatility, gas. No reason to protect
	// it, and protecting what does not need it costs without buying anything.
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

	// ⚠️ Remove before any deployment: logging from inside the enclave erodes precisely
	// what it protects. Only a status is traced here, never an amount.
	runtime.log(`decision: ${outcome.status} — ${outcome.reason}`)

	if (outcome.status !== 'PROPOSE') {
		return `${outcome.status}: ${outcome.reason}`
	}

	// ── Back to the DON for what requires consensus ──
	// Anything crossing here stops being confidential. Only the report crosses: a
	// commitment to the orders, and metrics in basis points. Not the plan, not the
	// balances, not the per-currency amounts.
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

	// The cleartext plan and its salt are not in the report: they stay with the operator,
	// who reveals them to the vault at execution time (D6).
	return `PROPOSE — ${outcome.reveal.orders.length} order(s), commitment ${r.ordersCommitment.slice(0, 10)}…`
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
