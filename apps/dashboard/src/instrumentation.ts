// Runs once when a server instance starts (Next.js instrumentation).
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // Credentials are saved encrypted (lib/cred-seal.ts). Without the key in
  // production, refuse to start so a bad deploy never takes traffic: staging
  // gets it from deploy-staging.yml; prod has it attached to the service once
  // (`gcloud run services update --update-secrets`) before the first Promote,
  // and Promote deploys with --no-traffic, so a missing key fails before traffic.
  if (process.env.NODE_ENV === 'production' && !process.env.WR_CRED_ENCRYPTION_KEY) {
    console.error('[cred-seal] WR_CRED_ENCRYPTION_KEY is not set; exiting.');
    process.exit(1);
  }

  // D2 stores no plain user_fleets.fleet_token, so migration 011 must have
  // made it nullable. Refuse to start in production when it plainly hasn't
  // (a failed check doesn't block: the first connection can fail at cold
  // start). Promote deploys with --no-traffic, so this fails before traffic.
  const { plainColumnsNullable, sealStoredCreds } = await import('@/lib/cred-seal');
  if (process.env.NODE_ENV === 'production' && (await plainColumnsNullable()) === false) {
    console.error('[cred-seal] user_fleets.fleet_token is still NOT NULL; apply migration 011. Exiting.');
    process.exit(1);
  }

  // Account deletion and plan lapse read users.closes_at on every
  // entitlement push, so migration 012 must be in before this revision
  // serves. Same shape as the 011 check above.
  const { closingColumnsPresent } = await import('@/lib/account-closing');
  if (process.env.NODE_ENV === 'production' && (await closingColumnsPresent()) === false) {
    console.error('[closing] users.closes_at is missing; apply migration 012. Exiting.');
    process.exit(1);
  }

  // Encrypt rows saved before encryption and clear their plain values, in the
  // background. A fresh instance's first database connection can fail, so
  // try a few times.
  void (async () => {
    for (const wait of [0, 15_000, 60_000]) {
      await new Promise((r) => setTimeout(r, wait));
      try {
        const { sealed, cleared } = await sealStoredCreds();
        if (sealed) console.log(`[cred-seal] encrypted ${sealed} stored credentials`);
        if (cleared) console.log(`[cred-seal] cleared ${cleared} plain credentials`);
        // Rows saved without a fleet id get it now, so the ownership check
        // can find holders by fleet id instead of decrypting tokens.
        const { recordLegacyFleetIds } = await import('@/lib/control-auth');
        const recorded = await recordLegacyFleetIds();
        if (recorded) console.log(`[cred-seal] recorded the fleet id on ${recorded} older rows`);
        return;
      } catch (err) {
        // Postgres errors carry a code; connection errors only a message,
        // logged with any word holding a digit, '/', ':', '.' or '@'
        // (hosts, paths, addresses, ports) masked.
        const e = err as { code?: string; message?: string };
        const why = e?.code ?? (e?.message?.replace(/\S*[\d/:.@]\S*/g, '…').slice(0, 120) || 'unknown');
        console.error(`[cred-seal] backfill failed (${why})`);
      }
    }
  })();
}
