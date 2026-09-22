import 'server-only';
import { Pool } from 'pg';

let pool: Pool | null = null;

// Lazily constructed: no connection attempt happens at module import time, so
// `next build`'s page-data collection pass doesn't need real DB env vars.
export function db(): Pool {
  if (!pool) {
    const socketPath = process.env.DB_SOCKET_PATH; // set only on Cloud Run, e.g. /cloudsql/whiteroom-prod:us-central1:whiteroom-tech-v1
    pool = new Pool({
      host: socketPath || process.env.DB_HOST || '127.0.0.1',
      port: socketPath ? undefined : Number(process.env.DB_PORT || 5432),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      max: 5,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 15_000,
      idle_in_transaction_session_timeout: 15_000,
    });
    // Idle sockets can fail outside a query's catch block. Handle the event
    // without logging connection details or allowing an uncaught exception.
    pool.on('error', () => console.error('[db] idle connection failed'));
  }
  return pool;
}
