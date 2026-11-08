// Queue a v2_bind outbox row for every account, so each one gets a v2
// entitlement snapshot, not only accounts that change after
// ENTITLEMENTS_V2=on. The outbox sweep (/api/internal/entitlement-sweep)
// delivers them like any other row.
//
// NOT a migration and not run by any deploy: run by hand in each region
// (staging, then US prod, then EU) once ENTITLEMENTS_V2=on there.
//
// Dry run by default: prints how many accounts there are and how many would
// be queued, and writes nothing. --apply writes, 500 accounts per statement,
// each committed on its own, so no long lock on the outbox. Safe to re-run:
// an account that already has an undelivered v2_bind row is skipped.
//
// The sweep delivers 50 accounts a run, oldest first, so the queued rows
// take about accounts / 50 sweep runs to drain, and newer outbox rows wait
// behind them. An account the engine refuses stays pending and is retried
// on every sweep: watch the sweep's log until the outbox is empty.
//
//   DATABASE_URL=postgres://… npm run v2:bind-all              # dry run
//   DATABASE_URL=postgres://… npm run v2:bind-all -- --apply   # write
//
// Without DATABASE_URL it uses the dashboard's DB_HOST / DB_PORT / DB_USER /
// DB_PASSWORD / DB_NAME (or DB_SOCKET_PATH). Needs Node 22.7 or later (it runs the TypeScript directly).
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import pg, { type ClientConfig } from 'pg';

export const BATCH_SIZE = 500;
export const REASON = 'v2_bind';

type Query = (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export interface BindAllResult {
  users: number;
  pending: number;
  queued: number;
}

const PENDING = `EXISTS (SELECT 1 FROM entitlement_outbox o
  WHERE o.user_id = u.id AND o.reason = '${REASON}' AND o.delivered_at IS NULL)`;
// The accounts with an undelivered v2_bind row, read once (a join, not a
// lookup per account: the outbox has no user_id index).
const PENDING_USERS = `SELECT DISTINCT user_id FROM entitlement_outbox
  WHERE reason = '${REASON}' AND delivered_at IS NULL`;

/** Counts accounts and those already waiting on a v2_bind row; with apply, queues the rest in batches. */
export async function bindAll(query: Query, opts: { apply: boolean; batchSize?: number; log?: (line: string) => void }): Promise<BindAllResult> {
  const log = opts.log ?? (() => {});
  const batchSize = opts.batchSize ?? BATCH_SIZE;
  const { rows: [count] } = await query(
    `SELECT count(*)::int AS users, count(p.user_id)::int AS pending
       FROM users u LEFT JOIN (${PENDING_USERS}) p ON p.user_id = u.id`,
  );
  const users = Number(count.users);
  const pending = Number(count.pending);
  log(`${users} accounts, ${pending} already pending, ${users - pending} to queue`);
  if (!opts.apply) {
    log('Dry run: nothing written. Run with --apply to queue them.');
    return { users, pending, queued: 0 };
  }

  // Keyset over users.id, so each account is looked at once even if the
  // sweep delivers (and so un-pends) earlier rows while this runs.
  let after: string | null = null;
  let queued = 0;
  for (;;) {
    const { rows: [batch] } = await query(
      `WITH batch AS (
         SELECT u.id FROM users u
          WHERE ($1::text IS NULL OR u.id > $1::text)
          ORDER BY u.id
          LIMIT $2
       ), ins AS (
         INSERT INTO entitlement_outbox (user_id, reason)
         SELECT u.id, '${REASON}' FROM batch u WHERE NOT ${PENDING}
         RETURNING 1
       )
       SELECT (SELECT max(id) FROM batch) AS last_id, (SELECT count(*) FROM ins)::int AS queued`,
      [after, batchSize],
    );
    if (batch.last_id == null) break;
    after = String(batch.last_id);
    queued += Number(batch.queued);
    log(`queued ${queued} so far`);
  }
  const runs = Math.ceil((pending + queued) / 50);
  log(`Done: queued ${queued}. The sweep takes about ${runs} ${runs === 1 ? 'run' : 'runs'} to deliver them.`);
  return { users, pending, queued };
}

function clientConfig(): ClientConfig {
  if (process.env.DATABASE_URL) return { connectionString: process.env.DATABASE_URL };
  const socketPath = process.env.DB_SOCKET_PATH;
  return {
    host: socketPath || process.env.DB_HOST || '127.0.0.1',
    port: socketPath ? undefined : Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  };
}

async function main(argv: string[]): Promise<void> {
  const unknown = argv.filter((a) => a !== '--apply');
  if (unknown.length) throw new Error(`Unknown argument: ${unknown.join(' ')}. The only option is --apply.`);
  const client = new pg.Client(clientConfig());
  await client.connect();
  try {
    // Fail fast rather than queue behind live traffic; on a timeout, run it again.
    await client.query(`SET lock_timeout = '5s'`);
    await bindAll((text, values) => client.query(text, values), { apply: argv.includes('--apply'), log: (l) => console.log(l) });
  } finally {
    await client.end();
  }
}

// Node reports import.meta.url with symlinks resolved, so resolve argv too
// (on macOS /tmp is a symlink): otherwise the script would exit 0 doing nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
