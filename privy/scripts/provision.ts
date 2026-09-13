/**
 * Provisions the organisation wallets and their policies.
 *
 *   node privy/scripts/provision.ts <vault-address> <treasury-policy-address>
 *
 * Requires PRIVY_APP_ID and PRIVY_APP_SECRET. Writes the result to privy/wallets.json,
 * which the dashboard and the end-to-end scenario consume.
 *
 * The script is **idempotent by intent**: it invents no address and fails loudly rather
 * than silently creating a duplicate when the file already exists.
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
    throw new Error('usage: node privy/scripts/provision.ts <vault> <treasury-policy>');
  }
  if (existsSync(OUT)) {
    throw new Error(
      `${OUT.pathname} already exists. Delete it deliberately rather than creating ` +
        'duplicate wallets.',
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
      `${role.padEnd(13)} ${wallet.address}  policy ${policy.id}  quorum ` +
        `${QUORUM[role].threshold}/${QUORUM[role].keys}`,
    );
  }

  writeFileSync(OUT, `${JSON.stringify({ vault, treasuryPolicy, roles: result }, null, 2)}\n`);
  console.log(`\nWritten to ${OUT.pathname}`);
  console.log(
    'Next step: grant the on-chain roles to these addresses via TreasuryPolicy.grantRole.',
  );
  console.log(
    'The contract will refuse to grant RISK_OFFICER and TREASURER to the same address — by design.',
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
