// Applies apps/dashboard/migrations/*.sql in name order and records each one
// in schema_migrations (file name, sha256 of its text, when it ran), so a
// database says which files it has.
//
// Run by hand, staging first, then US prod, then EU (ops/staging/README.md).
// Not run by any deploy.
//
//   DATABASE_URL=postgres://… npm run migrate                        # dry run: prints the plan
//   DATABASE_URL=postgres://… npm run migrate -- --apply             # applies what is pending
//   DATABASE_URL=postgres://… npm run migrate -- --baseline 018_x.sql          # dry run of a baseline
//   DATABASE_URL=postgres://… npm run migrate -- --baseline 018_x.sql --apply  # records 001..018 as applied
//
// Without DATABASE_URL it uses the dashboard's DB_HOST / DB_PORT / DB_USER /
// DB_PASSWORD / DB_NAME (or DB_SOCKET_PATH). Needs Node 22.7 or later (it
// runs the TypeScript directly).
//
// - A database that predates this runner is baselined once: every file up to
//   the named one is recorded as applied without being run. Refused if any
//   row is already recorded. --apply on a database with no schema_migrations
//   table is refused unless the database has no tables at all.
// - One runner at a time: --apply and --baseline --apply take an advisory
//   lock for the whole run. A second runner exits at once and says so.
// - Each file runs in one transaction with its schema_migrations row, so a
//   failed file leaves nothing behind and the next run tries it again.
// - A file that can't run in a transaction (CREATE INDEX CONCURRENTLY,
//   VACUUM) says so on a line of its own, `-- migrate: no-transaction`. It
//   runs through psql -f, as these files were applied before, and its row is
//   written only if psql succeeds, so it must be safe to re-run. Without the
//   line, Postgres refuses such a statement and the file is rolled back.
// - A recorded file whose text has changed, or that is no longer in the
//   directory, stops the run before anything is applied.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg, { type ClientConfig } from 'pg';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
export const LOCK_KEY = 'dashboard_migrations';
const FILE_RE = /^\d{3}_[a-z0-9_]+\.sql$/;

type Env = Record<string, string | undefined>;
type Query = (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export interface MigrationFile {
  name: string;
  sha256: string;
  sql: string;
  /** Runs outside a transaction, through psql. */
  noTransaction: boolean;
}

export interface MigrateOptions {
  dir?: string;
  apply: boolean;
  /** Record every file up to and including this one as applied, without running them. */
  baseline?: string;
  /** Runs a file outside a transaction. Default: psql -f with the same connection. */
  runOutside?: (file: MigrationFile) => void;
  log?: (line: string) => void;
}

export interface MigrateResult {
  pending: string[];
  applied: string[];
  baselined: string[];
}

export class MigrateError extends Error {}

/** The line a file that can't run in a transaction opts out with. Stated, not guessed from the SQL. */
export const NO_TRANSACTION_RE = /^-- migrate: no-transaction\s*$/m;

export function readMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  const names = readdirSync(dir).filter((f) => f.endsWith('.sql'));
  // A misnamed file would otherwise be skipped without a word.
  const misnamed = names.filter((f) => !FILE_RE.test(f));
  if (misnamed.length) throw new MigrateError(`Not named like NNN_name.sql (three digits, lower case): ${misnamed.join(', ')}. Rename it so the runner sees it.`);
  return names
    .sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name), 'utf8');
      return {
        name,
        sql,
        sha256: createHash('sha256').update(sql).digest('hex'),
        noTransaction: NO_TRANSACTION_RE.test(sql),
      };
    });
}

async function tableExists(query: Query): Promise<boolean> {
  const { rows } = await query(`SELECT to_regclass('schema_migrations') IS NOT NULL AS present`);
  return rows[0].present === true;
}

async function recorded(query: Query): Promise<Map<string, string>> {
  const { rows } = await query(`SELECT name, sha256 FROM schema_migrations ORDER BY name`);
  return new Map(rows.map((r) => [String(r.name), String(r.sha256)]));
}

/** Stops on a recorded file that changed or is gone. */
function checkRecorded(files: MigrationFile[], done: Map<string, string>): void {
  const byName = new Map(files.map((f) => [f.name, f]));
  const problems: string[] = [];
  for (const [name, sha] of done) {
    const file = byName.get(name);
    if (!file) problems.push(`${name} is recorded as applied but is no longer in the migrations directory`);
    else if (file.sha256 !== sha) problems.push(`${name} has changed since it was applied (sha256 ${sha.slice(0, 12)}… then, ${file.sha256.slice(0, 12)}… now)`);
  }
  if (problems.length) {
    throw new MigrateError(`${problems.join('\n')}\nAn applied migration must not be edited. Put the change in a new file.`);
  }
}

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  name       text PRIMARY KEY,
  sha256     text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  baseline   boolean NOT NULL DEFAULT false
)`;

/**
 * The run itself, given a connected client. Dry run unless `apply`. With
 * `apply`, holds the advisory lock on `client`'s session until it returns.
 */
export async function migrate(client: pg.Client, opts: MigrateOptions): Promise<MigrateResult> {
  const query: Query = (text, values) => client.query(text, values);
  const log = opts.log ?? (() => {});
  const files = readMigrations(opts.dir);
  const result: MigrateResult = { pending: [], applied: [], baselined: [] };

  if (opts.apply) {
    const { rows } = await query(`SELECT pg_try_advisory_lock(hashtext($1)) AS got`, [LOCK_KEY]);
    if (rows[0].got !== true) {
      throw new MigrateError('Another migration run holds the lock on this database. Wait for it to finish, then run this again.');
    }
  }
  try {
    const hasTable = await tableExists(query);
    const done = hasTable ? await recorded(query) : new Map<string, string>();

    if (opts.baseline) {
      const upTo = files.findIndex((f) => f.name === opts.baseline);
      if (upTo < 0) throw new MigrateError(`--baseline ${opts.baseline}: no such file in the migrations directory.`);
      if (done.size) throw new MigrateError(`--baseline refused: schema_migrations already records ${done.size} file(s). A database is baselined once.`);
      const marked = files.slice(0, upTo + 1);
      log(`Baseline: ${marked.length} file(s) to record as applied without running them, ${marked[0].name} to ${marked[marked.length - 1].name}.`);
      if (!opts.apply) {
        log('Dry run: nothing written. Run with --apply to record them.');
        return { ...result, baselined: marked.map((f) => f.name) };
      }
      await query('BEGIN');
      try {
        await query(CREATE_TABLE);
        for (const f of marked) {
          await query(`INSERT INTO schema_migrations (name, sha256, baseline) VALUES ($1, $2, true)`, [f.name, f.sha256]);
        }
        await query('COMMIT');
      } catch (err) {
        await query('ROLLBACK').catch(() => {});
        throw err;
      }
      log(`Recorded ${marked.length} file(s). Run without --baseline to see what is still pending.`);
      return { ...result, baselined: marked.map((f) => f.name) };
    }

    if (!hasTable) {
      const { rows } = await query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = current_schema()`);
      if (Number(rows[0].n) > 0) {
        throw new MigrateError('This database has tables but no schema_migrations table: it predates the runner. Baseline it first with --baseline <last file it has>.');
      }
    }

    checkRecorded(files, done);
    const pending = files.filter((f) => !done.has(f.name));
    result.pending = pending.map((f) => f.name);
    if (!pending.length) {
      log('Up to date: nothing pending.');
      return result;
    }
    log(`${pending.length} pending: ${pending.map((f) => (f.noTransaction ? `${f.name} (outside a transaction, through psql)` : f.name)).join(', ')}`);
    if (!opts.apply) {
      log('Dry run: nothing applied. Run with --apply to apply them.');
      return result;
    }

    await query(CREATE_TABLE);
    for (const f of pending) {
      log(`Applying ${f.name}…`);
      if (f.noTransaction) {
        (opts.runOutside ?? runWithPsql)(f);
        await query(`INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)`, [f.name, f.sha256]);
      } else {
        await query('BEGIN');
        try {
          await query(f.sql);
          await query(`INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)`, [f.name, f.sha256]);
          await query('COMMIT');
        } catch (err) {
          await query('ROLLBACK').catch(() => {});
          const message = (err as Error).message;
          const hint = /cannot run inside a transaction block/i.test(message)
            ? ' If the file is safe to re-run, add the line "-- migrate: no-transaction" to it so it runs through psql.'
            : '';
          throw new MigrateError(`${f.name} failed and was rolled back; nothing from it was kept: ${message}.${hint}`);
        }
      }
      result.applied.push(f.name);
      // A file's SET (lock_timeout) outlives its transaction; don't carry it into the next file.
      try {
        await query('RESET ALL');
      } catch (err) {
        throw new MigrateError(`${f.name} was applied and recorded, but resetting the session after it failed, so the run stopped there: ${(err as Error).message}`);
      }
    }
    log(`Applied ${result.applied.length} file(s).`);
    return result;
  } finally {
    if (opts.apply) await query(`SELECT pg_advisory_unlock(hashtext($1))`, [LOCK_KEY]).catch(() => {});
  }
}

export function clientConfig(env: Env = process.env): ClientConfig {
  if (env.DATABASE_URL) return { connectionString: env.DATABASE_URL };
  const socketPath = env.DB_SOCKET_PATH;
  return {
    host: socketPath || env.DB_HOST || '127.0.0.1',
    port: socketPath ? undefined : Number(env.DB_PORT || 5432),
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
  };
}

/**
 * The libpq variables for the database `clientConfig` names. A URL is split
 * into them rather than passed on psql's command line, where its password
 * would show in the process list.
 */
export function psqlEnv(env: Env = process.env): Record<string, string | undefined> {
  const c = clientConfig(env);
  if (!c.connectionString) {
    return { PGHOST: c.host, PGPORT: c.port ? String(c.port) : undefined, PGUSER: c.user, PGPASSWORD: env.DB_PASSWORD, PGDATABASE: c.database };
  }
  let u: URL;
  try {
    u = new URL(c.connectionString);
  } catch {
    throw new MigrateError('DATABASE_URL is not a URL this runner can hand to psql. Give the host in it (postgres://user:pass@host:port/db), or use DB_HOST, DB_PORT, DB_USER, DB_PASSWORD and DB_NAME.');
  }
  const dec = (s: string) => (s ? decodeURIComponent(s) : undefined);
  return {
    PGHOST: u.searchParams.get('host') ?? (dec(u.hostname) || undefined),
    PGPORT: u.port || undefined,
    PGUSER: dec(u.username),
    PGPASSWORD: dec(u.password),
    PGDATABASE: dec(u.pathname.replace(/^\//, '')),
    PGSSLMODE: u.searchParams.get('sslmode') ?? undefined,
  };
}

/** psql -f on the same database. */
function runWithPsql(file: MigrationFile): void {
  // Only what the config names; anything else (a PGPASSWORD already set, say) is left as it was.
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(psqlEnv())) if (v !== undefined) childEnv[k] = v;
  try {
    execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '-X', '-f', '-'], { input: file.sql, env: childEnv, stdio: ['pipe', 'inherit', 'inherit'] });
  } catch (err) {
    throw new MigrateError(`${file.name} failed in psql; it is not recorded, so the next run tries it again (it must be safe to re-run): ${(err as Error).message}`);
  }
}

export function parseArgs(argv: string[]): { apply: boolean; baseline?: string } {
  let apply = false;
  let baseline: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') apply = true;
    else if (argv[i] === '--baseline' && argv[i + 1] && !argv[i + 1].startsWith('--')) baseline = argv[++i];
    else throw new MigrateError(`Unknown argument: ${argv[i]}. Options: --apply, --baseline <file>.`);
  }
  return { apply, baseline };
}

async function main(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);
  const client = new pg.Client(clientConfig());
  await client.connect();
  try {
    await migrate(client, { ...opts, log: (l) => console.log(l) });
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
