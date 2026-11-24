import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate, type MigrateOptions } from '../../scripts/migrate';

// The migration runner against a real Postgres, with migration files written
// to a temporary directory for each test.
//
// Skipped unless WR_TEST_DATABASE names a scratch database you created for
// it (its public schema is dropped before each test). Needs psql on PATH for
// the file that runs outside a transaction. For example:
//   createdb -h localhost -p 5432 wr_migrate_test
//   WR_TEST_DATABASE=wr_migrate_test DB_PORT=5432 npx vitest run src/__tests__/migrate.db.test.ts
//   dropdb -h localhost -p 5432 wr_migrate_test
const DB = process.env.WR_TEST_DATABASE;
const HOST = process.env.DB_HOST || '127.0.0.1';
const PORT = process.env.DB_PORT || '5433';
const URL_ = `postgres://${HOST}:${PORT}/${DB}`;

describe.skipIf(!DB)('migration runner (Postgres)', () => {
  let dir: string;
  const clients: pg.Client[] = [];
  const connect = async () => {
    const c = new pg.Client({ connectionString: URL_ });
    await c.connect();
    clients.push(c);
    return c;
  };
  let db: pg.Client;
  const write = (name: string, sql: string) => writeFileSync(join(dir, name), sql);
  const run = async (opts: Partial<MigrateOptions> = {}, client = db) => migrate(client, { dir, apply: true, ...opts });
  const rows = async () => (await db.query(`SELECT name, baseline FROM schema_migrations ORDER BY name`)).rows;
  const exists = async (table: string) => (await db.query(`SELECT to_regclass($1) IS NOT NULL AS t`, [table])).rows[0].t;

  beforeAll(() => {
    // The runner's psql step reads the connection from the environment.
    process.env.DATABASE_URL = URL_;
  });
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wr-migrate-'));
    db = await connect();
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  });
  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true });
    await Promise.all(clients.splice(0).map((c) => c.end().catch(() => {})));
  });
  afterAll(() => {
    delete process.env.DATABASE_URL;
  });

  it('an empty database: applies every file in order, records each, and a second run finds nothing to do', async () => {
    write('001_a.sql', `SET lock_timeout = '5s'; CREATE TABLE a (id int PRIMARY KEY);`);
    write('002_b.sql', `CREATE TABLE b (id int REFERENCES a (id));`);
    expect(await run()).toMatchObject({ pending: ['001_a.sql', '002_b.sql'], applied: ['001_a.sql', '002_b.sql'] });
    expect(await rows()).toEqual([{ name: '001_a.sql', baseline: false }, { name: '002_b.sql', baseline: false }]);
    // A file's SET doesn't outlive it.
    expect((await db.query(`SHOW lock_timeout`)).rows[0].lock_timeout).toBe('0');
    expect(await run()).toMatchObject({ pending: [], applied: [] });
  });

  it('dry run (the default) writes nothing, not even the table', async () => {
    write('001_a.sql', `CREATE TABLE a (id int);`);
    const log: string[] = [];
    expect(await run({ apply: false, log: (l) => log.push(l) })).toMatchObject({ pending: ['001_a.sql'], applied: [] });
    expect(await exists('schema_migrations')).toBe(false);
    expect(await exists('a')).toBe(false);
    expect(log.at(-1)).toMatch(/Dry run/);
  });

  it('a database that predates the runner is refused until baselined', async () => {
    await db.query(`CREATE TABLE users (id text)`);
    write('001_a.sql', `CREATE TABLE a (id int);`);
    await expect(run()).rejects.toThrow(/predates the runner. Baseline it first/);
    await expect(run({ apply: false })).rejects.toThrow(/Baseline it first/);
    expect(await exists('a')).toBe(false);
  });

  it('baseline: records up to the named file without running them, then only later files run; a second baseline is refused', async () => {
    await db.query(`CREATE TABLE users (id text)`);
    write('001_a.sql', `SELECT 1/0;`); // would fail if it ran
    write('002_b.sql', `SELECT 1/0;`);
    write('003_c.sql', `CREATE TABLE c (id int);`);
    expect(await run({ baseline: '002_b.sql', apply: false })).toMatchObject({ baselined: ['001_a.sql', '002_b.sql'] });
    expect(await exists('schema_migrations')).toBe(false);
    await expect(run({ baseline: '009_none.sql' })).rejects.toThrow(/no such file/);
    expect(await run({ baseline: '002_b.sql' })).toMatchObject({ baselined: ['001_a.sql', '002_b.sql'] });
    expect(await rows()).toEqual([{ name: '001_a.sql', baseline: true }, { name: '002_b.sql', baseline: true }]);
    expect(await run()).toMatchObject({ applied: ['003_c.sql'] });
    await expect(run({ baseline: '003_c.sql' })).rejects.toThrow(/baselined once/);
  });

  it('a failing file is rolled back whole and recorded nowhere; the next run tries it again', async () => {
    write('001_a.sql', `CREATE TABLE a (id int);`);
    write('002_b.sql', `CREATE TABLE b (id int); INSERT INTO b VALUES (1); SELECT 1/0;`);
    await expect(run()).rejects.toThrow(/002_b.sql failed and was rolled back/);
    expect(await rows()).toEqual([{ name: '001_a.sql', baseline: false }]);
    expect(await exists('b')).toBe(false);
    write('002_b.sql', `CREATE TABLE b (id int); INSERT INTO b VALUES (1);`);
    expect(await run()).toMatchObject({ applied: ['002_b.sql'] });
    expect((await db.query(`SELECT count(*)::int AS n FROM b`)).rows[0].n).toBe(1);
  });

  it('an applied file that changed, or is gone, stops the run before anything is applied', async () => {
    write('001_a.sql', `CREATE TABLE a (id int);`);
    await run();
    write('001_a.sql', `CREATE TABLE a (id bigint);`);
    write('002_b.sql', `CREATE TABLE b (id int);`);
    await expect(run()).rejects.toThrow(/001_a.sql has changed since it was applied/);
    await expect(run({ apply: false })).rejects.toThrow(/has changed/);
    expect(await exists('b')).toBe(false);
    unlinkSync(join(dir, '001_a.sql'));
    await expect(run()).rejects.toThrow(/001_a.sql is recorded as applied but is no longer/);
    expect(await exists('b')).toBe(false);
  });

  it('two runners at once: one applies, the other stops at once and says why', async () => {
    write('001_slow.sql', `SELECT pg_sleep(1); CREATE TABLE slow (id int);`);
    const [a, b] = [await connect(), await connect()];
    const results = await Promise.allSettled([run({}, a), run({}, b)]);
    const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(String(failed[0].reason)).toMatch(/Another migration run holds the lock/);
    expect(await rows()).toEqual([{ name: '001_slow.sql', baseline: false }]);
    // The lock is released when the run ends.
    write('002_b.sql', `CREATE TABLE b (id int);`);
    expect(await run({}, b)).toMatchObject({ applied: ['002_b.sql'] });
  });

  it('a file with CREATE INDEX CONCURRENTLY runs outside a transaction, through psql', async () => {
    write('001_a.sql', `CREATE TABLE a (id int);`);
    write('002_idx.sql', `-- migrate: no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS a_id ON a (id);`);
    const log: string[] = [];
    expect(await run({ apply: false, log: (l) => log.push(l) })).toMatchObject({ pending: ['001_a.sql', '002_idx.sql'] });
    expect(log.join('\n')).toMatch(/002_idx.sql \(outside a transaction, through psql\)/);
    expect(await run()).toMatchObject({ applied: ['001_a.sql', '002_idx.sql'] });
    expect(await exists('a_id')).toBe(true);
    expect(await rows()).toHaveLength(2);
  });

  it('a psql failure records nothing, so the next run tries the file again', async () => {
    write('001_a.sql', `CREATE TABLE a (id int);`);
    write('002_idx.sql', `-- migrate: no-transaction\nCREATE INDEX CONCURRENTLY a_id ON missing_table (id);`);
    await expect(run()).rejects.toThrow(/002_idx.sql failed in psql; it is not recorded/);
    expect(await rows()).toEqual([{ name: '001_a.sql', baseline: false }]);
    write('002_idx.sql', `-- migrate: no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS a_id ON a (id);`);
    expect(await run()).toMatchObject({ applied: ['002_idx.sql'] });
  });

  it('CONCURRENTLY without the no-transaction line is refused by Postgres, rolled back, and the error says what to add', async () => {
    write('001_a.sql', `CREATE TABLE a (id int);`);
    write('002_idx.sql', `CREATE TABLE b (id int); CREATE INDEX CONCURRENTLY a_id ON a (id);`);
    await expect(run()).rejects.toThrow(/002_idx.sql failed and was rolled back[^]*add the line "-- migrate: no-transaction"/);
    expect(await exists('b')).toBe(false);
    expect(await rows()).toEqual([{ name: '001_a.sql', baseline: false }]);
  });
});
