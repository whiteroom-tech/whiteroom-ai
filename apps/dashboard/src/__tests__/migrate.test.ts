import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, parseArgs, psqlEnv, readMigrations } from '../../scripts/migrate';

// The parts of the runner that need no database. The runs themselves are in
// migrate.db.test.ts, against a real Postgres.
describe('migration runner', () => {
  it('reads the real migrations in name order, and only 013 runs outside a transaction', () => {
    const files = readMigrations(MIGRATIONS_DIR);
    expect(files[0].name).toBe('001_nextauth.sql');
    expect(files.map((f) => f.name)).toEqual([...files.map((f) => f.name)].sort());
    expect(files.filter((f) => f.noTransaction).map((f) => f.name)).toEqual(['013_outbox_not_before.sql']);
    expect(files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
  });

  it("only a file with the line -- migrate: no-transaction runs outside a transaction; the words alone don't count", () => {
    const dir = mkdtempSync(join(tmpdir(), 'wr-migrate-notx-'));
    try {
      writeFileSync(join(dir, '001_a.sql'), `/* VACUUM later */ COMMENT ON TABLE t IS 'built CONCURRENTLY'; -- CONCURRENTLY\n`);
      writeFileSync(join(dir, '002_b.sql'), `-- migrate: no-transaction\nCREATE INDEX CONCURRENTLY i ON t (id);\n`);
      writeFileSync(join(dir, '003_c.sql'), `-- not: -- migrate: no-transaction\nSELECT 1;\n`);
      expect(readMigrations(dir).map((f) => [f.name, f.noTransaction])).toEqual([['001_a.sql', false], ['002_b.sql', true], ['003_c.sql', false]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a .sql file not named NNN_name.sql stops the run instead of being skipped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wr-migrate-names-'));
    try {
      writeFileSync(join(dir, '001_a.sql'), 'SELECT 1;');
      writeFileSync(join(dir, 'README.md'), 'not a migration');
      expect(readMigrations(dir).map((f) => f.name)).toEqual(['001_a.sql']);
      writeFileSync(join(dir, '19_b.sql'), 'SELECT 1;');
      expect(() => readMigrations(dir)).toThrow(/Not named like NNN_name.sql .*: 19_b.sql/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('dry run by default; --apply and --baseline <file>; anything else refused', () => {
    expect(parseArgs([])).toEqual({ apply: false, baseline: undefined });
    expect(parseArgs(['--baseline', '018_proxy_keys.sql', '--apply'])).toEqual({ apply: true, baseline: '018_proxy_keys.sql' });
    expect(() => parseArgs(['--baseline'])).toThrow(/Unknown argument: --baseline/);
    expect(() => parseArgs(['--baseline', '--apply'])).toThrow(/Unknown argument/);
    expect(() => parseArgs(['--force'])).toThrow(/Unknown argument: --force/);
    expect(() => parseArgs(['--baseline', '017_a.sql', '--baseline', '018_b.sql'])).toThrow(/--baseline is given twice/);
  });

  it('gives psql a URL as separate variables, so its password never goes on the command line', () => {
    expect(psqlEnv({ DATABASE_URL: 'postgres://app:p%40ss@127.0.0.1:5441/whiteroom_dashboard?sslmode=disable' })).toEqual({
      PGHOST: '127.0.0.1', PGPORT: '5441', PGUSER: 'app', PGPASSWORD: 'p@ss', PGDATABASE: 'whiteroom_dashboard', PGSSLMODE: 'disable',
    });
    expect(psqlEnv({ DATABASE_URL: 'postgres://app@localhost/db?host=/cloudsql/x' })).toMatchObject({ PGHOST: '/cloudsql/x', PGDATABASE: 'db', PGPASSWORD: undefined });
    expect(() => psqlEnv({ DATABASE_URL: 'postgres://app@/db' })).toThrow(/DATABASE_URL is not a URL/);
    expect(psqlEnv({ DATABASE_URL: 'postgres://app@db.internal/d?sslmode=verify-full&sslrootcert=/ca.pem&connect_timeout=5&application_name=wr-migrate' })).toMatchObject({
      PGSSLMODE: 'verify-full', PGSSLROOTCERT: '/ca.pem', PGCONNECT_TIMEOUT: '5', PGAPPNAME: 'wr-migrate',
    });
    expect(() => psqlEnv({ DATABASE_URL: 'postgres://app@db.internal/d?ssl=true&uselibpqcompat=true' })).toThrow(/options psql can't be given the same way: ssl, uselibpqcompat/);
    expect(psqlEnv({ DB_HOST: 'h', DB_PORT: '6000', DB_USER: 'u', DB_PASSWORD: 'pw', DB_NAME: 'd' })).toEqual({
      PGHOST: 'h', PGPORT: '6000', PGUSER: 'u', PGPASSWORD: 'pw', PGDATABASE: 'd',
    });
  });
});
