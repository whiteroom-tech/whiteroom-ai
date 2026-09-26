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

  // max_id bounds the acknowledgement below: a row enqueued while this user's
  // sync is in flight may not be reflected in what was sent, so it stays
  // pending for the next sweep.
  const { rows: pending } = await db().query(
    `SELECT user_id, max(id) AS max_id
     FROM entitlement_outbox
     WHERE delivered_at IS NULL
     GROUP BY user_id
     ORDER BY min(created_at)
     LIMIT $1`,
    [BATCH_SIZE],
  );

  if (pending.length === 0) {
    return Response.json({ swept: 0 });
  }

  let delivered = 0;
  for (const row of pending) {
    try {
      if (!(await syncEntitlementsToEngine(row.user_id))) {
        console.error(`[sweep] engine did not acknowledge user ${row.user_id}; leaving pending`);
        continue;
      }
      await db().query(
        `UPDATE entitlement_outbox SET delivered_at = now()
         WHERE user_id = $1 AND id <= $2 AND delivered_at IS NULL`,
        [row.user_id, row.max_id],
      );
      delivered++;
    } catch {
      console.error(`[sweep] failed for user ${row.user_id}`);
    }
  }

  return Response.json({ swept: delivered, pending: pending.length });
}
