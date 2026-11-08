import 'server-only';
import { Client, Pool, type PoolConfig } from 'pg';

let pool: Pool | null = null;

/**
 * How to reach the database, for the pool and for the rare connection held
 * outside it (lib/entitlements' per-user lock). Same socket, credentials and
 * timeouts either way, so a waiter gives up after statement_timeout.
 */
export function pgConfig(): PoolConfig {
  const socketPath = process.env.DB_SOCKET_PATH; // set only on Cloud Run, e.g. /cloudsql/whiteroom-prod:us-central1:whiteroom-tech-v1
  return {
    host: socketPath || process.env.DB_HOST || '127.0.0.1',
    port: socketPath ? undefined : Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
    idle_in_transaction_session_timeout: 15_000,
  };
}

/** Pool size per instance when DB_POOL_MAX is unset or invalid (prod). */
export const DEFAULT_POOL_MAX = 10;

/**
 * Connections per instance, from DB_POOL_MAX: a whole number from 2 to 50.
 * Anything else falls back to DEFAULT_POOL_MAX. Staging sets it lower so its
 * small database isn't run out of connection slots.
 */
export function poolMax(raw = process.env.DB_POOL_MAX): number {
  const value = raw?.trim();
  if (!value || !/^\d+$/.test(value)) return DEFAULT_POOL_MAX;
  const n = Number(value);
  return n >= 2 && n <= 50 ? n : DEFAULT_POOL_MAX;
}

// Lazily constructed: no connection attempt happens at module import time, so
// `next build`'s page-data collection pass doesn't need real DB env vars.
export function db(): Pool {
  if (!pool) {
    pool = new Pool({ ...pgConfig(), max: poolMax(), idleTimeoutMillis: 5 * 60_000 });
    // Idle sockets can fail outside a query's catch block. Handle the event
    // without logging connection details or allowing an uncaught exception.
    pool.on('error', () => console.error('[db] idle connection failed'));
  }
  return pool;
}

/** A connection of its own, outside the pool, for holding a session lock (lib/entitlements). */
export function lockClient(): Pick<Client, 'connect' | 'query' | 'end' | 'on'> {
  return new Client(pgConfig());
}

/** Anything that runs a query: the pool, or a transaction's client. */
export type Queryable = Pick<Pool, 'query'>;
