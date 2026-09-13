/**
 * End-to-end scenario.
 *
 * Every piece of NEAP is tested in isolation. This script checks the one thing unit tests
 * cannot: that they fit together. Deploy, configure, let the engine decide, sign, submit,
 * approve, execute, observe the balances move.
 *
 *   node scripts/e2e.ts
 *
 * Requires Foundry. `cast` acts as the reference implementation for ECDSA signing —
 * writing secp256k1 by hand would be two hundred lines of modular arithmetic for a piece
 * that Chainlink's DON provides in production.
 */

import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

import { RISK_CURRENCIES, simulateMarket } from '../data/src/market.ts';
import { standardizedResiduals } from '../engine/src/risk/residuals.ts';
import { reportDigest } from '../engine/src/onchain/abi.ts';
import { keccak256Hex } from '../engine/src/onchain/keccak.ts';
import { buildReport } from '../cre/handler/buildReport.ts';
import type { ChainConfig, TreasurySnapshot } from '../cre/handler/types.ts';
import { CURRENCY_COSTS } from '../engine/src/backtest/config.ts';
import type { Currency } from '../data/src/types.ts';

const RPC = 'http://127.0.0.1:8545';
const CHAIN_ID = 31337n;

// Deterministic anvil accounts.
const ADMIN = {
  address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  key: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
};
const TREASURER = {
  address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  key: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
};
const DON_SIGNER = {
  address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  key: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
};

const BANDS = { lower: 400_000, target: 600_000, upper: 900_000 };
const RATE_EUR = 0.92;
const AUTO_APPROVE = 100_000;

let step = 0;
const say = (message: string) => console.log(`\n${String(++step).padStart(2, '0')}  ${message}`);
const detail = (message: string) => console.log(`    ${message}`);

const ROOT = new URL('..', import.meta.url).pathname;

/**
 * `stderr` is captured rather than allowed to leak to the console: Foundry writes
 * unrelated warnings there, and it is also where the decoded revert message lives — which
 * we need.
 */
function sh(command: string, args: readonly string[], cwd = ROOT): string {
  return execFileSync(command, args, {
    encoding: 'utf8',
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

/** Gathers everything an `execFileSync` failure produced, message and streams included. */
function outputOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) return String(error);
  const e = error as { message?: string; stdout?: string; stderr?: string };
  return [e.message, e.stdout, e.stderr].filter(Boolean).join('\n');
}

const cast = (...args: string[]) => sh('cast', args);

function send(from: { key: string }, to: string, signature: string, ...args: string[]): string {
  return cast('send', to, signature, ...args, '--rpc-url', RPC, '--private-key', from.key, '--json');
}

/**
 * Custom contract errors, indexed by selector.
 *
 * `cast` can decode them when it finds the project artifacts, and returns four raw bytes
 * otherwise. They are resolved with the same keccak as the rest of the engine — the third
 * use of that implementation, after the order commitment and the Privy policy selectors.
 */
const ERROR_BY_SELECTOR = new Map(
  [
    'Unauthorized(bytes32,address)',
    'SeparationOfDutiesViolated(address)',
    'WrongStatus(bytes32,uint8,uint8)',
    'ApprovalNotRequired(bytes32)',
    'CommitmentMismatch(bytes32,bytes32)',
    'NotionalMismatch(uint256,uint128)',
    'SingleOrderTooLarge(address,uint256,uint128)',
    'EpochLimitExceeded(uint256,uint128)',
    'RollingLimitExceeded(uint256,uint128)',
    'PriceDeviation(uint256,uint256,uint32)',
    'ReportAlreadyConsumed(bytes32)',
    'TokenNotSupported(address)',
    'SystemPaused()',
    'EmptyPlan()',
  ].map((signature) => [keccak256Hex(signature).slice(0, 10), signature.replace(/\(.*/, '')]),
);

/**
 * Returns the named error when the call fails, or null when it succeeds.
 *
 * `cast` decodes custom errors and the name sits at the end of its failure message. A
 * scenario printing "refused: 0x0dcd1bf9" demonstrates nothing; a scenario printing
 * "refused: SeparationOfDutiesViolated" demonstrates *which* guard fired, which is
 * precisely the point of the demonstration.
 */
function sendExpectingRevert(
  from: { key: string },
  to: string,
  signature: string,
  ...args: string[]
): string | null {
  try {
    send(from, to, signature, ...args);
    return null;
  } catch (error) {
    const text = outputOf(error);
    const named = /([A-Z][A-Za-z0-9_]*)\((?:[^()]*)\)\s*$/m.exec(text);
    if (named) return named[0].trim();
    const selector = /custom error (0x[0-9a-fA-F]{8})/.exec(text);
    if (selector) return ERROR_BY_SELECTOR.get(selector[1]!.toLowerCase()) ?? `reverted (${selector[1]})`;
    return 'reverted';
  }
}

const call = (to: string, signature: string, ...args: string[]) =>
  cast('call', to, signature, ...args, '--rpc-url', RPC);

const units = (amount: number) => BigInt(Math.round(amount * 1e6));

async function main(): Promise<void> {
  let anvil: ChildProcess | null = null;

  try {
    say('Starting the local node');
    anvil = spawn('anvil', ['--silent', '--port', '8545'], { stdio: 'ignore' });
    // The first calls fail until the node is listening: that is expected, and `sh`
    // captures stderr, so nothing is printed.
    for (let i = 0; i < 60; i++) {
      try {
        cast('block-number', '--rpc-url', RPC);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    detail(`block ${cast('block-number', '--rpc-url', RPC)}`);

    // ── Deployment ────────────────────────────────────────────────────────────
    say('Deploying the system');
    const deployOutput = sh(
      'forge',
      ['script', 'script/Deploy.s.sol', '--sig', 'run(string)', 'anvil',
       '--rpc-url', RPC, '--private-key', ADMIN.key, '--broadcast'],
      `${ROOT}contracts`,
    );

    const pick = (label: string): string => {
      const m = new RegExp(`${label}\\s+(0x[0-9a-fA-F]{40})`).exec(deployOutput);
      if (!m) throw new Error(`address not found for ${label}`);
      return m[1]!;
    };
    const policy = pick('TreasuryPolicy');
    const verifier = pick('ReportVerifier');
    const vault = pick('RebalanceVault');
    const usdc = pick('USDC');
    const eurc = pick('EURC');
    detail(`policy ${policy}`);
    detail(`verifier ${verifier}`);
    detail(`vault ${vault}`);

    // ── Separation of duties ──────────────────────────────────────────────────
    say('Separation of duties — the contract refuses the overlap');
    const refusal = sendExpectingRevert(
      ADMIN, policy, 'grantRole(bytes32,address)',
      cast('keccak', 'TREASURER'), ADMIN.address,
    );
    if (refusal === null) throw new Error('holding both RISK_OFFICER and TREASURER should have been refused');
    detail(`refused: ${refusal}`);
    detail('the deployer holds RISK_OFFICER, so it cannot be treasurer');

    send(ADMIN, policy, 'grantRole(bytes32,address)', cast('keccak', 'TREASURER'), TREASURER.address);
    detail(`separate treasurer: ${TREASURER.address}`);

    send(ADMIN, verifier, 'setSigner(address,bool)', DON_SIGNER.address, 'true');
    detail(`DON signer: ${DON_SIGNER.address}`);

    // ── Policy ────────────────────────────────────────────────────────────────
    say('The risk officer queues the policy');
    const currencyTuple =
      `(${units(BANDS.lower)},${units(BANDS.target)},${units(BANDS.upper)},` +
      `${units(2_000_000)},${units(5_000_000)},${units(20_000_000)})`;
    const riskTuple = `(1000,50,30,600,0,${units(AUTO_APPROVE)})`;

    send(ADMIN, policy, 'queueCurrencyPolicy(address,(uint128,uint128,uint128,uint128,uint128,uint128))', eurc, currencyTuple);
    send(ADMIN, policy, 'queueRiskParams((uint32,uint32,uint32,uint32,uint32,uint128))', riskTuple);
    detail('two pending changes, 24-hour timelock');

    say('The timelock elapses, then the changes apply');
    cast('rpc', 'evm_increaseTime', '86401', '--rpc-url', RPC);
    cast('rpc', 'evm_mine', '--rpc-url', RPC);

    const idCurrency = cast('keccak', cast('abi-encode', 'f(string,address,(uint128,uint128,uint128,uint128,uint128,uint128))', 'currency', eurc, currencyTuple));
    const idRisk = cast('keccak', cast('abi-encode', 'f(string,(uint32,uint32,uint32,uint32,uint32,uint128))', 'risk', riskTuple));
    send(ADMIN, policy, 'executeCurrencyPolicy(bytes32)', idCurrency);
    send(ADMIN, policy, 'executeRiskParams(bytes32)', idRisk);

    const bandParamsHash = cast('keccak', 'float-band-params-v1');
    send(ADMIN, policy, 'commitBandParams(bytes32)', bandParamsHash);

    const policyVersion = BigInt(call(policy, 'policyVersion()(uint32)').split(' ')[0]!);
    detail(`policy version: ${policyVersion}`);

    // ── Funding the vault ─────────────────────────────────────────────────────
    say('Funding the vault');
    const eurcHeld = BANDS.lower * 0.25;
    send(ADMIN, usdc, 'mint(address,uint256)', vault, units(20_000_000).toString());
    send(ADMIN, eurc, 'mint(address,uint256)', vault, units(eurcHeld * RATE_EUR).toString());
    detail(`USDC ${(20_000_000).toLocaleString('en-US')} · EURC ${Math.round(eurcHeld * RATE_EUR).toLocaleString('en-US')}`);
    detail(`equivalent ${Math.round(eurcHeld).toLocaleString('en-US')} — below the lower threshold of ${BANDS.lower.toLocaleString('en-US')}`);

    // ── Engine decision ───────────────────────────────────────────────────────
    say('The engine decides');
    // The chain clock advanced 24 hours during the timelock: it is the authority. A
    // report dated from the local machine's clock would be rejected as stale.
    const chainTime = Number(cast('block', 'latest', '--field', 'timestamp', '--rpc-url', RPC));
    const market = simulateMarket(4242, 400);
    const { residuals, currentVol } = standardizedResiduals(market.returns, RISK_CURRENCIES);

    const chain: ChainConfig = {
      numeraire: 'USD',
      currencies: RISK_CURRENCIES as readonly Currency[],
      tokens: { USD: usdc, EUR: eurc, GBP: eurc, BRL: eurc },
      decimals: 6,
      slippageBps: 30,
      validitySec: 3600,
    };

    const wide = { lower: 0, target: 0, upper: Number.MAX_SAFE_INTEGER };
    const limitsFor = (c: Currency) => ({
      costs: CURRENCY_COSTS[c]!.costs,
      maxSingleOrder: 2_000_000,
      settlementDays: CURRENCY_COSTS[c]!.settlementDays,
    });

    const treasury: TreasurySnapshot = {
      epoch: 100,
      nonce: 1,
      balances: { USD: 20_000_000, EUR: eurcHeld, GBP: 0, BRL: 0 },
      commitments: [],
      policyVersion: Number(policyVersion),
      bandParamsHash,
      // Only the euro carries an active band: the other two currencies are out of scope
      // for this scenario, and an infinitely wide band neutralises them without dead
      // code.
      bands: { EUR: BANDS, GBP: wide, BRL: wide },
      limits: { EUR: limitsFor('EUR'), GBP: limitsFor('GBP'), BRL: limitsFor('BRL') },
      risk: {
        horizonDays: 1 / 96,
        alpha: 0.975,
        basisHaircutBps: 50,
        lotSize: 10_000,
        minOrder: 20_000,
        autoApproveThreshold: AUTO_APPROVE,
        maxPerEpoch: 5_000_000,
        fundingFloor: 1_000_000,
        maxStalenessSec: 600,
      },
    };

    const nowMs = chainTime * 1000;
    const outcome = buildReport({
      treasury,
      market: {
        timestamp: nowMs,
        currentVol,
        residuals,
        rates: { EUR: RATE_EUR, GBP: 0.79, BRL: 5.4 },
        gasUsdc: 0.02,
      },
      chain,
      saltSeed: 'graine-de-scenario',
      now: nowMs,
    });

    if (outcome.status !== 'PROPOSE') throw new Error(`unexpected decision: ${outcome.status} — ${outcome.reason}`);
    const order = outcome.reveal.orders[0]!;
    detail(`${outcome.status} — ${outcome.reveal.orders.length} order`);
    detail(`buy ${(Number(order.minAmountOut) / 1e6).toLocaleString('en-US')} EURC against ${(Number(order.amountIn) / 1e6).toLocaleString('en-US')} USDC`);
    detail(`ES ${outcome.report.esBeforeBps} → ${outcome.report.esAfterBps} bps · commitment ${outcome.report.ordersCommitment.slice(0, 18)}…`);

    // ── Signature ─────────────────────────────────────────────────────────────
    say('The quorum signs the report');
    const r = outcome.report;
    const digest = reportDigest(r, CHAIN_ID, verifier);
    const onchainDigest = call(verifier, 'digest((uint64,uint64,uint64,uint64,uint32,bytes32,bytes32,bytes32,int32,int32,uint128,uint128))(bytes32)',
      `(${r.epoch},${r.nonce},${r.expiry},${r.inputsTimestamp},${r.policyVersion},${r.bandParamsHash},${r.inputsHash},${r.ordersCommitment},${r.esBeforeBps},${r.esAfterBps},${r.costEstimate},${r.grossNotional})`);
    if (digest !== onchainDigest.trim()) {
      throw new Error(`empreinte divergente\n  TypeScript ${digest}\n  Solidity   ${onchainDigest}`);
    }
    detail(`identical EIP-712 digest on both sides: ${digest.slice(0, 18)}…`);

    const signature = cast('wallet', 'sign', '--no-hash', '--private-key', DON_SIGNER.key, digest);
    const measurement = call(verifier, 'expectedMeasurement()(bytes32)').trim();
    const attestation = `0x${measurement.slice(2)}${digest.slice(2)}`;

    // ── Submission ────────────────────────────────────────────────────────────
    say('The operator submits the report');
    const reportTuple = `(${r.epoch},${r.nonce},${r.expiry},${r.inputsTimestamp},${r.policyVersion},${r.bandParamsHash},${r.inputsHash},${r.ordersCommitment},${r.esBeforeBps},${r.esAfterBps},${r.costEstimate},${r.grossNotional})`;
    send(ADMIN, vault, 'submit((uint64,uint64,uint64,uint64,uint32,bytes32,bytes32,bytes32,int32,int32,uint128,uint128),bytes,bytes[])',
      reportTuple, attestation, `[${signature}]`);

    const reportId = call(verifier, 'reportId((uint64,uint64,uint64,uint64,uint32,bytes32,bytes32,bytes32,int32,int32,uint128,uint128))(bytes32)', reportTuple).trim();
    const statusOf = () => Number(call(vault, 'statusOf(bytes32)(uint8)', reportId).split(' ')[0]);
    detail(`plan ${reportId.slice(0, 18)}… · status ${['None', 'AwaitingApproval', 'Ready', 'Settled'][statusOf()]}`);

    // ── Approval ──────────────────────────────────────────────────────────────
    say('Notional exceeds the threshold: human approval required');
    const tooEarly = sendExpectingRevert(ADMIN, vault, 'execute(bytes32,(address,address,uint128,uint128)[],bytes32)',
      reportId, `[(${order.sell},${order.buy},${order.amountIn},${order.minAmountOut})]`, outcome.reveal.salt);
    if (tooEarly === null) throw new Error('execution without approval should have been refused');
    detail(`execution refused before approval: ${tooEarly}`);

    const selfApproval = sendExpectingRevert(ADMIN, vault, 'approve(bytes32)', reportId);
    if (selfApproval === null) throw new Error('the operator should not have been able to approve');
    detail(`self-approval refused: ${selfApproval}`);

    send(TREASURER, vault, 'approve(bytes32)', reportId);
    detail(`approved by the treasurer · status ${['None', 'AwaitingApproval', 'Ready', 'Settled'][statusOf()]}`);

    // ── Execution ─────────────────────────────────────────────────────────────
    say('Execution');
    const before = {
      usdc: BigInt(call(usdc, 'balanceOf(address)(uint256)', vault).split(' ')[0]!),
      eurc: BigInt(call(eurc, 'balanceOf(address)(uint256)', vault).split(' ')[0]!),
    };
    send(ADMIN, vault, 'execute(bytes32,(address,address,uint128,uint128)[],bytes32)',
      reportId, `[(${order.sell},${order.buy},${order.amountIn},${order.minAmountOut})]`, outcome.reveal.salt);
    const after = {
      usdc: BigInt(call(usdc, 'balanceOf(address)(uint256)', vault).split(' ')[0]!),
      eurc: BigInt(call(eurc, 'balanceOf(address)(uint256)', vault).split(' ')[0]!),
    };

    const fmt = (v: bigint) => (Number(v) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 0 });
    detail(`USDC ${fmt(before.usdc)} → ${fmt(after.usdc)}   (${fmt(after.usdc - before.usdc)})`);
    detail(`EURC ${fmt(before.eurc)} → ${fmt(after.eurc)}   (+${fmt(after.eurc - before.eurc)})`);
    detail(`status ${['None', 'AwaitingApproval', 'Ready', 'Settled'][statusOf()]}`);

    // ── Replay ────────────────────────────────────────────────────────────────
    say('Replay is refused');
    const replay = sendExpectingRevert(ADMIN, vault, 'execute(bytes32,(address,address,uint128,uint128)[],bytes32)',
      reportId, `[(${order.sell},${order.buy},${order.amountIn},${order.minAmountOut})]`, outcome.reveal.salt);
    if (replay === null) throw new Error('a replay should have been refused');
    detail(`refused: ${replay}`);

    // ── Checks ────────────────────────────────────────────────────────────────
    say('Checks');
    const spent = before.usdc - after.usdc;
    const received = after.eurc - before.eurc;
    const checks: [string, boolean][] = [
      ['the plan is settled', statusOf() === 3],
      ['the amount spent matches the plan', spent === order.amountIn],
      ['the amount received meets the minimum', received >= order.minAmountOut],
      ['the realised rate is close to the reference rate', Math.abs(Number(received) / Number(spent) / RATE_EUR - 1) < 0.01],
    ];
    for (const [label, passed] of checks) detail(`${passed ? '✔' : '✘'} ${label}`);
    if (checks.some(([, passed]) => !passed)) throw new Error('a check failed');

    console.log('\n✔ Full chain verified: deployment → policy → decision → signature → submission → approval → execution\n');
  } finally {
    anvil?.kill();
  }
}

main().catch((error: unknown) => {
  console.error(`\n✘ ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
