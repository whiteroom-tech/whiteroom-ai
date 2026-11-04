import { db } from '@/lib/db';
import { markOutboxDelivered, syncEntitlementsToEngine } from '@/lib/entitlements';
import { syncSecretMatches } from '@/lib/sync-secret';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BATCH_SIZE = 50;

export async function POST(req: Request): Promise<Response> {
  if (!syncSecretMatches(req.headers.get('x-wr-sync-secret'))) {
    return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  // Delivered rows only matter for a while after: keep a month. Housekeeping, so it never fails the sweep.
  await db().query(`DELETE FROM entitlement_outbox WHERE delivered_at < now() - interval '30 days'`).catch(() => {});

  // max_id bounds the acknowledgement below: a row enqueued while this user's
  // sync is in flight may not be reflected in what was sent, so it stays
  // pending for the next sweep.
  const { rows: pending } = await db().query(
    `SELECT user_id, max(id) AS max_id
     FROM entitlement_outbox
     WHERE delivered_at IS NULL AND (not_before IS NULL OR not_before <= now())
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
      await markOutboxDelivered(row.user_id, row.max_id);
      delivered++;
    } catch {
      console.error(`[sweep] failed for user ${row.user_id}`);
    }
  }

  return Response.json({ swept: delivered, pending: pending.length });
}
