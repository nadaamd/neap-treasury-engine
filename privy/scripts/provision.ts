/**
 * Provisionne les portefeuilles d'organisation et leurs politiques.
 *
 *   node privy/scripts/provision.ts <adresse-coffre> <adresse-treasury-policy>
 *
 * Exige PRIVY_APP_ID et PRIVY_APP_SECRET. Écrit le résultat dans privy/wallets.json,
 * que le tableau de bord et le scénario de bout en bout consomment.
 *
 * Le script est **idempotent par intention** : il n'invente aucune adresse et échoue
 * bruyamment plutôt que de créer un doublon silencieux si le fichier existe déjà.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { createPolicy, createWallet, credentialsFromEnv } from '../src/client.ts';
import { buildAllPolicies, QUORUM } from '../src/policies.ts';
import type { Role } from '../src/policies.ts';
import { VAULT_ABI_FRAGMENT } from '../src/abi.ts';

const OUT = new URL('../wallets.json', import.meta.url);

async function main(): Promise<void> {
  const [vault, treasuryPolicy] = process.argv.slice(2);
  if (!vault || !treasuryPolicy) {
    throw new Error('usage : node privy/scripts/provision.ts <coffre> <treasury-policy>');
  }
  if (existsSync(OUT)) {
    throw new Error(
      `${OUT.pathname} existe déjà. Le supprimer sciemment plutôt que de créer des ` +
        'portefeuilles en double.',
    );
  }

  const creds = credentialsFromEnv(process.env);
  const policies = buildAllPolicies({ vault, treasuryPolicy, abi: VAULT_ABI_FRAGMENT });

  const result: Record<string, { policyId: string; walletId: string; address: string }> = {};

  for (const role of Object.keys(policies) as Role[]) {
    const policy = await createPolicy(creds, policies[role]);
    const wallet = await createWallet(creds, {
      chain_type: 'ethereum',
      policy_ids: [policy.id],
    });
    result[role] = { policyId: policy.id, walletId: wallet.id, address: wallet.address };
    console.log(
      `${role.padEnd(13)} ${wallet.address}  politique ${policy.id}  quorum ` +
        `${QUORUM[role].threshold}/${QUORUM[role].keys}`,
    );
  }

  writeFileSync(OUT, `${JSON.stringify({ vault, treasuryPolicy, roles: result }, null, 2)}\n`);
  console.log(`\nÉcrit dans ${OUT.pathname}`);
  console.log(
    'Étape suivante : attribuer les rôles on-chain à ces adresses via TreasuryPolicy.grantRole.',
  );
  console.log(
    "Le contrat refusera d'attribuer RISK_OFFICER et TREASURER à la même adresse — c'est voulu.",
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
