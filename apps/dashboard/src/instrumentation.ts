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

  // Encrypt rows saved before encryption, in the background. A fresh
  // instance's first database connection can fail, so try a few times.
  const { sealStoredCreds } = await import('@/lib/cred-seal');
  void (async () => {
    for (const wait of [0, 15_000, 60_000]) {
      await new Promise((r) => setTimeout(r, wait));
      try {
        const n = await sealStoredCreds();
        if (n) console.log(`[cred-seal] encrypted ${n} stored credentials`);
        return;
      } catch (err) {
        // Postgres errors carry a code; connection errors only a message (no values).
        const e = err as { code?: string; message?: string };
        console.error(`[cred-seal] backfill failed (${e?.code ?? String(e?.message).slice(0, 120)})`);
      }
    }
  })();
}
