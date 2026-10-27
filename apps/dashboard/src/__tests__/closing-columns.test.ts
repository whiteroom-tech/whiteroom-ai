// The production boot check for migration 012: true only when every column
// it adds is there in this schema; null (don't block a cold start) when the
// check itself can't run.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db', () => ({ db: () => ({ query }) }));
vi.mock('@/lib/email', () => ({ sendEmail: vi.fn(), EMAIL_FROM: 'x' }));
vi.mock('@/lib/whiteroom/client', () => ({ PROXY_URL: 'http://engine.test' }));

const { closingColumnsPresent } = await import('@/lib/account-closing');

describe('closingColumnsPresent', () => {
  beforeEach(() => query.mockReset());

  it('is true only when all of 012’s columns are in this schema', async () => {
    query.mockResolvedValueOnce({ rows: [{ n: 7 }] });
    expect(await closingColumnsPresent()).toBe(true);
    const [sql, params] = query.mock.calls[0] as [string, string[][]];
    expect(sql).toContain('current_schema()');
    expect(params[0]).toEqual(expect.arrayContaining(['closes_at', 'close_reason', 'delete_after', 'closing_email_sent_at', 'close_blocked_at', 'close_blocked_notified_at', 'close_blocked_email_attempts']));
  });

  it('is false when any is missing, so production refuses to start on an unmigrated database', async () => {
    query.mockResolvedValueOnce({ rows: [{ n: 6 }] });
    expect(await closingColumnsPresent()).toBe(false);
    query.mockResolvedValueOnce({ rows: [{ n: 0 }] });
    expect(await closingColumnsPresent()).toBe(false);
  });

  it('is null when the check can’t run, so a connection blip doesn’t stop a start', async () => {
    query.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await closingColumnsPresent()).toBeNull();
    query.mockResolvedValueOnce({ rows: [] });
    expect(await closingColumnsPresent()).toBeNull();
  });
});
