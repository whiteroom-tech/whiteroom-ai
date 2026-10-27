// The full signed audit export as the dashboard builds it: pages followed to
// the end, one file with every event and the signed manifest, retries on a
// busy engine, and the older export from an engine without the full one.
import { describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({ signed: vi.fn() }));
vi.mock('@/lib/whiteroom/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/whiteroom/client')>()),
  exportAuditSigned: client.signed,
}));

const { buildAuditExport } = await import('@/lib/audit-export');
const { WhiteRoomApiError } = await import('@/lib/whiteroom/client');
type Page = import('@/lib/whiteroom/types').AuditExportPage;

const HEAD = 1_234;
const event = (seq: number) => ({ seq, id: `e${seq}`, type: 'task_complete', prevHash: `h${seq - 1}`, hash: `h${seq}`, payload: { n: seq } });

/** A fake engine: pages of `size` from seq 1 to HEAD, the manifest on the last. */
function engine(size = 500) {
  const calls: Array<{ fromSeq: number; toSeq: number } | undefined> = [];
  const fetchPage = vi.fn(async (_fleet: string, cursor?: { fromSeq: number; toSeq: number }): Promise<Page> => {
    calls.push(cursor);
    const from = cursor?.fromSeq ?? 1;
    const to = cursor?.toSeq ?? HEAD;
    const upTo = Math.min(to, from + size - 1);
    const events = Array.from({ length: upTo - from + 1 }, (_, i) => event(from + i));
    return {
      fleetId: 'f1', firstSeq: 1, toSeq: to, fromSeq: from, events, nextFromSeq: upTo < to ? upTo + 1 : null,
      ...(upTo >= to && { manifest: { format: 'whiteroom-audit-export', headSeq: to, headHash: `h${to}`, count: to, signature: 'sig' } }),
    };
  });
  return { fetchPage, calls };
}

describe('full audit export', () => {
  it('follows every page into one file with all events in order and the signed manifest', async () => {
    const { fetchPage, calls } = engine();
    const progress: Array<[number, number]> = [];
    const file = await buildAuditExport('f1', (d, t) => progress.push([d, t]), { fetchPage });
    expect(calls).toEqual([undefined, { fromSeq: 501, toSeq: HEAD }, { fromSeq: 1001, toSeq: HEAD }]);
    expect(file!.events).toBe(HEAD);
    const parsed = JSON.parse(await file!.blob.text());
    expect(parsed).toMatchObject({ format: 'whiteroom-audit-export', version: 1, fleetId: 'f1' });
    expect(parsed.events.map((e: { seq: number }) => e.seq)).toEqual(Array.from({ length: HEAD }, (_, i) => i + 1));
    expect(parsed.events[1]).toEqual(event(2));
    expect(parsed.manifest).toMatchObject({ headSeq: HEAD, headHash: `h${HEAD}`, count: HEAD, signature: 'sig' });
    expect(progress).toEqual([[500, HEAD], [1000, HEAD], [HEAD, HEAD]]);
    expect(client.signed).not.toHaveBeenCalled();
  });

  it('waits and tries again when the engine is busy', async () => {
    const { fetchPage } = engine(1_000);
    fetchPage.mockRejectedValueOnce(new WhiteRoomApiError('HTTP 429', 429));
    const wait = vi.fn(async () => {});
    const file = await buildAuditExport('f1', () => {}, { fetchPage, wait });
    expect(wait).toHaveBeenCalledTimes(1);
    expect(file!.events).toBe(HEAD);
  });

  it('gives up after a few busy answers, and at once on other errors', async () => {
    const busy = vi.fn(async () => { throw new WhiteRoomApiError('HTTP 502', 502); });
    await expect(buildAuditExport('f1', () => {}, { fetchPage: busy, wait: async () => {} })).rejects.toThrow('HTTP 502');
    expect(busy).toHaveBeenCalledTimes(4);
    const denied = vi.fn(async () => { throw new WhiteRoomApiError('HTTP 401', 401); });
    await expect(buildAuditExport('f1', () => {}, { fetchPage: denied, wait: async () => {} })).rejects.toThrow('HTTP 401');
    expect(denied).toHaveBeenCalledTimes(1);
  });

  it('uses the older signed export on an engine without the full one', async () => {
    client.signed.mockResolvedValueOnce({ fleetId: 'f1', entries: [], signature: 'old' });
    const old = vi.fn(async () => { throw new WhiteRoomApiError('HTTP 400', 400, 'Unknown action.'); });
    const file = await buildAuditExport('f1', () => {}, { fetchPage: old });
    expect(file!.events).toBeNull();
    expect(JSON.parse(await file!.blob.text())).toMatchObject({ signature: 'old' });
  });

  it('fails rather than save a file without its signature', async () => {
    const { fetchPage } = engine(5_000);
    const unsigned = vi.fn(async (f: string, c?: { fromSeq: number; toSeq: number }) => ({ ...(await fetchPage(f, c)), manifest: undefined }));
    await expect(buildAuditExport('f1', () => {}, { fetchPage: unsigned })).rejects.toThrow('signature');
  });

  it('stops between pages once cancelled', async () => {
    const { fetchPage } = engine();
    const file = await buildAuditExport('f1', () => {}, { fetchPage, isCancelled: () => true });
    expect(file).toBeNull();
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});
