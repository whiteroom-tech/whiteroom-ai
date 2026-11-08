import { describe, expect, it, vi } from 'vitest';
import { BATCH_SIZE, bindAll } from '../../scripts/v2-bind-all';

// The script against a recorded query function. The SQL itself runs against
// Postgres in entitlements-v2.db.test.ts (v2 bind-all script).
function fakeQuery(batches: Array<{ last_id: string | null; queued: number }>) {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const query = vi.fn(async (text: string, values?: unknown[]) => {
    calls.push({ text, values });
    if (text.includes('LEFT JOIN')) return { rows: [{ users: 1200, pending: 200 }] };
    return { rows: [batches.shift() ?? { last_id: null, queued: 0 }] };
  });
  return { query, calls };
}

describe('v2 bind-all', () => {
  it('dry run (the default): prints the counts and runs no write', async () => {
    const { query, calls } = fakeQuery([]);
    const log: string[] = [];
    expect(await bindAll(query, { apply: false, log: (l) => log.push(l) })).toEqual({ users: 1200, pending: 200, queued: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0].text).not.toMatch(/INSERT/i);
    expect(log).toEqual(['1200 accounts, 200 already pending, 1000 to queue', 'Dry run: nothing written. Run with --apply to queue them.']);
  });

  it('--apply: 500 a batch, carrying on after the last id until a batch is empty', async () => {
    const { query, calls } = fakeQuery([{ last_id: 'u-0500', queued: 400 }, { last_id: 'u-1000', queued: 500 }, { last_id: 'u-1200', queued: 100 }]);
    expect(BATCH_SIZE).toBe(500);
    expect(await bindAll(query, { apply: true })).toEqual({ users: 1200, pending: 200, queued: 1000 });
    const writes = calls.slice(1);
    expect(writes.map((c) => c.values)).toEqual([[null, 500], ['u-0500', 500], ['u-1000', 500], ['u-1200', 500]]);
    for (const w of writes) {
      expect(w.text).toContain(`INSERT INTO entitlement_outbox (user_id, reason)`);
      expect(w.text).toContain(`'v2_bind'`);
      // Skips an account that already has an undelivered v2_bind row.
      expect(w.text).toMatch(/NOT EXISTS \(SELECT 1 FROM entitlement_outbox o\s+WHERE o\.user_id = u\.id AND o\.reason = 'v2_bind' AND o\.delivered_at IS NULL\)/);
    }
  });
});
