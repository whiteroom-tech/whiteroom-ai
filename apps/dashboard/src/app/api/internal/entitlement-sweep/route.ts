import { timingSafeEqual } from 'node:crypto';
import { db } from '@/lib/db';
import { syncEntitlementsToEngine } from '@/lib/entitlements';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BATCH_SIZE = 50;

function secretMatches(secret: string | null, expected: string | undefined): boolean {
  if (!secret || !expected) return false;
  const a = Buffer.from(secret);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: Request): Promise<Response> {
  const secret = req.headers.get('x-wr-sync-secret');
  if (!secretMatches(secret, process.env.WR_ENTITLEMENT_SYNC_SECRET)) {
    return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const { rows: pending } = await db().query(
    `SELECT DISTINCT ON (user_id) id, user_id
     FROM entitlement_outbox
     WHERE delivered_at IS NULL
     ORDER BY user_id, created_at DESC
     LIMIT $1`,
    [BATCH_SIZE],
  );

  if (pending.length === 0) {
    return Response.json({ swept: 0 });
  }

  let delivered = 0;
  for (const row of pending) {
    try {
      await syncEntitlementsToEngine(row.user_id);
      await db().query(
        `UPDATE entitlement_outbox SET delivered_at = now()
         WHERE user_id = $1 AND delivered_at IS NULL`,
        [row.user_id],
      );
      delivered++;
    } catch {
      console.error(`[sweep] failed for user ${row.user_id}`);
    }
  }

  return Response.json({ swept: delivered, pending: pending.length });
}
