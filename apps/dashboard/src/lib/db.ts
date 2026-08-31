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
    });
  }
  return pool;
}
