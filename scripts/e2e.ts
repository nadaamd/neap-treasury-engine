/**
 * Scénario de bout en bout.
 *
 * Chaque pièce de FLOAT est testée isolément. Ce script vérifie la seule chose que les
 * tests unitaires ne peuvent pas vérifier : qu'elles s'emboîtent. Déployer, configurer,
 * faire décider le moteur, signer, soumettre, approuver, exécuter, constater le
 * mouvement des soldes.
 *
 *   node scripts/e2e.ts
 *
 * Exige Foundry. `cast` sert d'implémentation de référence pour la signature ECDSA —
 * écrire secp256k1 à la main serait deux cents lignes d'arithmétique modulaire pour une
 * pièce que le DON de Chainlink assure en production.
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

// Comptes anvil déterministes.
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
 * `stderr` est capturé plutôt que laissé fuir vers la console : Foundry y écrit des
 * avertissements sans rapport, et c'est aussi là que se trouve le message de révocation
 * décodé — dont on a besoin.
 */
function sh(command: string, args: readonly string[], cwd = ROOT): string {
  return execFileSync(command, args, {
    encoding: 'utf8',
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

/** Réunit tout ce qu'un échec d'`execFileSync` a produit, message et flux compris. */
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
 * Erreurs personnalisées des contrats, indexées par sélecteur.
 *
 * `cast` sait les décoder quand il retrouve les artefacts du projet, et rend quatre
 * octets bruts sinon. On les résout avec le même keccak que le reste du moteur —
 * troisième emploi de cette implémentation, après l'engagement sur les ordres et les
 * sélecteurs des politiques Privy.
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
 * Renvoie l'erreur nommée si l'appel échoue, ou null s'il réussit.
 *
 * `cast` décode les erreurs personnalisées et le nom se trouve à la fin de son message
 * d'échec. Un scénario qui affiche « refusé : 0x0dcd1bf9 » ne démontre rien ; un
 * scénario qui affiche « refusé : SeparationOfDutiesViolated » démontre *quelle* garde
 * a joué, ce qui est précisément l'objet de la démonstration.
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
    if (selector) return ERROR_BY_SELECTOR.get(selector[1]!.toLowerCase()) ?? `révoqué (${selector[1]})`;
    return 'révoqué';
  }
}

const call = (to: string, signature: string, ...args: string[]) =>
  cast('call', to, signature, ...args, '--rpc-url', RPC);

const units = (amount: number) => BigInt(Math.round(amount * 1e6));

async function main(): Promise<void> {
  let anvil: ChildProcess | null = null;

  try {
    say('Démarrage du nœud local');
    anvil = spawn('anvil', ['--silent', '--port', '8545'], { stdio: 'ignore' });
    // Les premiers appels échouent tant que le nœud n'écoute pas : c'est attendu, et
    // `sh` capture stderr, donc rien ne s'affiche.
    for (let i = 0; i < 60; i++) {
      try {
        cast('block-number', '--rpc-url', RPC);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    detail(`bloc ${cast('block-number', '--rpc-url', RPC)}`);

    // ── Déploiement ───────────────────────────────────────────────────────────
    say('Déploiement du système');
    const deployOutput = sh(
      'forge',
      ['script', 'script/Deploy.s.sol', '--sig', 'run(string)', 'anvil',
       '--rpc-url', RPC, '--private-key', ADMIN.key, '--broadcast'],
      `${ROOT}contracts`,
    );

    const pick = (label: string): string => {
      const m = new RegExp(`${label}\\s+(0x[0-9a-fA-F]{40})`).exec(deployOutput);
      if (!m) throw new Error(`adresse introuvable pour ${label}`);
      return m[1]!;
    };
    const policy = pick('TreasuryPolicy');
    const verifier = pick('ReportVerifier');
    const vault = pick('RebalanceVault');
    const usdc = pick('USDC');
    const eurc = pick('EURC');
    detail(`politique ${policy}`);
    detail(`vérificateur ${verifier}`);
    detail(`coffre ${vault}`);

    // ── Séparation des devoirs ────────────────────────────────────────────────
    say('Séparation des devoirs — le contrat refuse le cumul');
    const refusal = sendExpectingRevert(
      ADMIN, policy, 'grantRole(bytes32,address)',
      cast('keccak', 'TREASURER'), ADMIN.address,
    );
    if (refusal === null) throw new Error('le cumul RISK_OFFICER + TREASURER aurait dû être refusé');
    detail(`refus : ${refusal}`);
    detail("le déployeur détient RISK_OFFICER, il ne peut donc pas être trésorier");

    send(ADMIN, policy, 'grantRole(bytes32,address)', cast('keccak', 'TREASURER'), TREASURER.address);
    detail(`trésorier distinct : ${TREASURER.address}`);

    send(ADMIN, verifier, 'setSigner(address,bool)', DON_SIGNER.address, 'true');
    detail(`signataire du DON : ${DON_SIGNER.address}`);

    // ── Politique ─────────────────────────────────────────────────────────────
    say('Le responsable des risques met la politique en file');
    const currencyTuple =
      `(${units(BANDS.lower)},${units(BANDS.target)},${units(BANDS.upper)},` +
      `${units(2_000_000)},${units(5_000_000)},${units(20_000_000)})`;
    const riskTuple = `(1000,50,30,600,0,${units(AUTO_APPROVE)})`;

    send(ADMIN, policy, 'queueCurrencyPolicy(address,(uint128,uint128,uint128,uint128,uint128,uint128))', eurc, currencyTuple);
    send(ADMIN, policy, 'queueRiskParams((uint32,uint32,uint32,uint32,uint32,uint128))', riskTuple);
    detail('deux changements en attente, délai de 24 heures');

    say('Le délai s’écoule, puis les changements s’appliquent');
    cast('rpc', 'evm_increaseTime', '86401', '--rpc-url', RPC);
    cast('rpc', 'evm_mine', '--rpc-url', RPC);

    const idCurrency = cast('keccak', cast('abi-encode', 'f(string,address,(uint128,uint128,uint128,uint128,uint128,uint128))', 'currency', eurc, currencyTuple));
    const idRisk = cast('keccak', cast('abi-encode', 'f(string,(uint32,uint32,uint32,uint32,uint32,uint128))', 'risk', riskTuple));
    send(ADMIN, policy, 'executeCurrencyPolicy(bytes32)', idCurrency);
    send(ADMIN, policy, 'executeRiskParams(bytes32)', idRisk);

    const bandParamsHash = cast('keccak', 'float-band-params-v1');
    send(ADMIN, policy, 'commitBandParams(bytes32)', bandParamsHash);

    const policyVersion = BigInt(call(policy, 'policyVersion()(uint32)').split(' ')[0]!);
    detail(`version de politique : ${policyVersion}`);

    // ── Approvisionnement du coffre ───────────────────────────────────────────
    say('Approvisionnement du coffre');
    const eurcHeld = BANDS.lower * 0.25;
    send(ADMIN, usdc, 'mint(address,uint256)', vault, units(20_000_000).toString());
    send(ADMIN, eurc, 'mint(address,uint256)', vault, units(eurcHeld * RATE_EUR).toString());
    detail(`USDC ${(20_000_000).toLocaleString('fr-FR')} · EURC ${Math.round(eurcHeld * RATE_EUR).toLocaleString('fr-FR')}`);
    detail(`équivalent ${Math.round(eurcHeld).toLocaleString('fr-FR')} — sous le seuil bas de ${BANDS.lower.toLocaleString('fr-FR')}`);

    // ── Décision du moteur ────────────────────────────────────────────────────
    say('Le moteur décide');
    // L'horloge de la chaîne a avancé de 24 heures pendant le délai : c'est elle qui
    // fait foi. Un rapport daté de l'horloge du poste serait rejeté comme périmé.
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
      // Seul l'euro porte une bande active : les deux autres devises sont hors périmètre
      // pour ce scénario, et une bande infiniment large les neutralise sans code mort.
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

    if (outcome.status !== 'PROPOSE') throw new Error(`décision inattendue : ${outcome.status} — ${outcome.reason}`);
    const order = outcome.reveal.orders[0]!;
    detail(`${outcome.status} — ${outcome.reveal.orders.length} ordre`);
    detail(`acheter ${(Number(order.minAmountOut) / 1e6).toLocaleString('fr-FR')} EURC contre ${(Number(order.amountIn) / 1e6).toLocaleString('fr-FR')} USDC`);
    detail(`ES ${outcome.report.esBeforeBps} → ${outcome.report.esAfterBps} bps · engagement ${outcome.report.ordersCommitment.slice(0, 18)}…`);

    // ── Signature ─────────────────────────────────────────────────────────────
    say('Signature du rapport par le quorum');
    const r = outcome.report;
    const digest = reportDigest(r, CHAIN_ID, verifier);
    const onchainDigest = call(verifier, 'digest((uint64,uint64,uint64,uint64,uint32,bytes32,bytes32,bytes32,int32,int32,uint128,uint128))(bytes32)',
      `(${r.epoch},${r.nonce},${r.expiry},${r.inputsTimestamp},${r.policyVersion},${r.bandParamsHash},${r.inputsHash},${r.ordersCommitment},${r.esBeforeBps},${r.esAfterBps},${r.costEstimate},${r.grossNotional})`);
    if (digest !== onchainDigest.trim()) {
      throw new Error(`empreinte divergente\n  TypeScript ${digest}\n  Solidity   ${onchainDigest}`);
    }
    detail(`empreinte EIP-712 identique des deux côtés : ${digest.slice(0, 18)}…`);

    const signature = cast('wallet', 'sign', '--no-hash', '--private-key', DON_SIGNER.key, digest);
    const measurement = call(verifier, 'expectedMeasurement()(bytes32)').trim();
    const attestation = `0x${measurement.slice(2)}${digest.slice(2)}`;

    // ── Soumission ────────────────────────────────────────────────────────────
    say('L’opérateur soumet le rapport');
    const reportTuple = `(${r.epoch},${r.nonce},${r.expiry},${r.inputsTimestamp},${r.policyVersion},${r.bandParamsHash},${r.inputsHash},${r.ordersCommitment},${r.esBeforeBps},${r.esAfterBps},${r.costEstimate},${r.grossNotional})`;
    send(ADMIN, vault, 'submit((uint64,uint64,uint64,uint64,uint32,bytes32,bytes32,bytes32,int32,int32,uint128,uint128),bytes,bytes[])',
      reportTuple, attestation, `[${signature}]`);

    const reportId = call(verifier, 'reportId((uint64,uint64,uint64,uint64,uint32,bytes32,bytes32,bytes32,int32,int32,uint128,uint128))(bytes32)', reportTuple).trim();
    const statusOf = () => Number(call(vault, 'statusOf(bytes32)(uint8)', reportId).split(' ')[0]);
    detail(`plan ${reportId.slice(0, 18)}… · état ${['None', 'AwaitingApproval', 'Ready', 'Settled'][statusOf()]}`);

    // ── Approbation ───────────────────────────────────────────────────────────
    say('Le notionnel dépasse le seuil : approbation humaine requise');
    const tooEarly = sendExpectingRevert(ADMIN, vault, 'execute(bytes32,(address,address,uint128,uint128)[],bytes32)',
      reportId, `[(${order.sell},${order.buy},${order.amountIn},${order.minAmountOut})]`, outcome.reveal.salt);
    if (tooEarly === null) throw new Error('une exécution sans approbation aurait dû être refusée');
    detail(`exécution refusée avant approbation : ${tooEarly}`);

    const selfApproval = sendExpectingRevert(ADMIN, vault, 'approve(bytes32)', reportId);
    if (selfApproval === null) throw new Error("l'opérateur n'aurait pas dû pouvoir approuver");
    detail(`auto-approbation refusée : ${selfApproval}`);

    send(TREASURER, vault, 'approve(bytes32)', reportId);
    detail(`approuvé par le trésorier · état ${['None', 'AwaitingApproval', 'Ready', 'Settled'][statusOf()]}`);

    // ── Exécution ─────────────────────────────────────────────────────────────
    say('Exécution');
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

    const fmt = (v: bigint) => (Number(v) / 1e6).toLocaleString('fr-FR', { maximumFractionDigits: 0 });
    detail(`USDC ${fmt(before.usdc)} → ${fmt(after.usdc)}   (${fmt(after.usdc - before.usdc)})`);
    detail(`EURC ${fmt(before.eurc)} → ${fmt(after.eurc)}   (+${fmt(after.eurc - before.eurc)})`);
    detail(`état ${['None', 'AwaitingApproval', 'Ready', 'Settled'][statusOf()]}`);

    // ── Rejeu ─────────────────────────────────────────────────────────────────
    say('Le rejeu est refusé');
    const replay = sendExpectingRevert(ADMIN, vault, 'execute(bytes32,(address,address,uint128,uint128)[],bytes32)',
      reportId, `[(${order.sell},${order.buy},${order.amountIn},${order.minAmountOut})]`, outcome.reveal.salt);
    if (replay === null) throw new Error('un rejeu aurait dû être refusé');
    detail(`refus : ${replay}`);

    // ── Contrôles ─────────────────────────────────────────────────────────────
    say('Contrôles');
    const spent = before.usdc - after.usdc;
    const received = after.eurc - before.eurc;
    const checks: [string, boolean][] = [
      ['le plan est réglé', statusOf() === 3],
      ['le montant dépensé est celui du plan', spent === order.amountIn],
      ['le montant reçu respecte le minimum', received >= order.minAmountOut],
      ['le taux obtenu est proche du taux de référence', Math.abs(Number(received) / Number(spent) / RATE_EUR - 1) < 0.01],
    ];
    for (const [label, passed] of checks) detail(`${passed ? '✔' : '✘'} ${label}`);
    if (checks.some(([, passed]) => !passed)) throw new Error('un contrôle a échoué');

    console.log('\n✔ Chaîne complète vérifiée : déploiement → politique → décision → signature → soumission → approbation → exécution\n');
  } finally {
    anvil?.kill();
  }
}

main().catch((error: unknown) => {
  console.error(`\n✘ ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
