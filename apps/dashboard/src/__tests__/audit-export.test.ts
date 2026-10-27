// The full signed audit export as the dashboard builds it: pages followed to
// the end, one file with every event and the signed manifest, retries on a
// busy engine, and the older export from an engine without the full one.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({ signed: vi.fn() }));
vi.mock('@/lib/whiteroom/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/whiteroom/client')>()),
  exportAuditSigned: client.signed,
}));

const { buildAuditExport } = await import('@/lib/audit-export');
const { WhiteRoomApiError } = await import('@/lib/whiteroom/client');
type Page = import('@/lib/whiteroom/types').AuditExportPage;

const HEAD = 1_234;
/** Total time a fake wait was asked to wait. */
const waited = (wait: { mock: { calls: unknown[][] } }) => wait.mock.calls.reduce((t, [ms]) => t + (ms as number), 0);
const event = (seq: number) => ({ seq, id: `e${seq}`, type: 'task_complete', prevHash: `h${seq - 1}`, hash: `h${seq}`, payload: { n: seq } });

/** A fake engine: pages of `size` from seq 1 to HEAD, the manifest on the last. */
function engine(size = 500, first = 1) {
  const calls: Array<{ fromSeq: number; toSeq: number } | undefined> = [];
  const fetchPage = vi.fn(async (_fleet: string, cursor?: { fromSeq: number; toSeq: number }): Promise<Page> => {
    calls.push(cursor);
    const from = cursor?.fromSeq ?? first;
    const to = cursor?.toSeq ?? HEAD;
    const upTo = Math.min(to, from + size - 1);
    const events = Array.from({ length: upTo - from + 1 }, (_, i) => event(from + i));
    return {
      fleetId: 'f1', firstSeq: first, toSeq: to, fromSeq: from, events, nextFromSeq: upTo < to ? upTo + 1 : null,
      ...(upTo >= to && { manifest: { format: 'whiteroom-audit-export', firstSeq: first, headSeq: to, headHash: `h${to}`, count: to - first + 1, signature: 'sig' } }),
    };
  });
  return { fetchPage, calls };
}

describe('full audit export', () => {
  // Each test owns the older-export mock: counts never carry over.
  beforeEach(() => { client.signed.mockReset(); });

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
    const wait = vi.fn(async (_ms: number) => {});
    const file = await buildAuditExport('f1', () => {}, { fetchPage, wait });
    expect(waited(wait)).toBe(5_000);
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
    let pages = 0;
    fetchPage.mockImplementation(async (f, c) => { pages++; return (await engine().fetchPage(f, c)); });
    const file = await buildAuditExport('f1', () => {}, { fetchPage, isCancelled: () => pages >= 1 });
    expect(file).toBeNull();
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('uses the older signed export for a fleet whose history isn’t stored yet (409)', async () => {
    client.signed.mockResolvedValueOnce({ fleetId: 'f1', entries: [], signature: 'old' });
    const notTracked = vi.fn(async () => { throw new WhiteRoomApiError('HTTP 409', 409, 'History tracking hasn’t started for this fleet yet.'); });
    const file = await buildAuditExport('f1', () => {}, { fetchPage: notTracked });
    expect(file!.events).toBeNull();
    expect(notTracked).toHaveBeenCalledTimes(1);
    expect(client.signed).toHaveBeenCalledTimes(1);
    expect(client.signed).toHaveBeenCalledWith('f1');
  });

  it('passes on any other refusal instead of falling back', async () => {
    const refused = vi.fn(async () => { throw new WhiteRoomApiError('HTTP 400', 400, 'to_seq is outside this fleet’s stored history.'); });
    await expect(buildAuditExport('f1', () => {}, { fetchPage: refused })).rejects.toThrow('HTTP 400');
    expect(refused).toHaveBeenCalledTimes(1);
    expect(client.signed).not.toHaveBeenCalled();
  });

  it('retries a busy later page and carries on from the same place', async () => {
    const { fetchPage } = engine();
    const real = fetchPage.getMockImplementation()!;
    let failed = false;
    fetchPage.mockImplementation(async (f, c) => {
      if (c?.fromSeq === 501 && !failed) { failed = true; throw new WhiteRoomApiError('HTTP 503', 503); }
      return real(f, c);
    });
    const wait = vi.fn(async (_ms: number) => {});
    const file = await buildAuditExport('f1', () => {}, { fetchPage, wait });
    expect(waited(wait)).toBe(5_000);
    expect(fetchPage.mock.calls.map(([, c]) => c?.fromSeq)).toEqual([undefined, 501, 501, 1001]);
    expect(file!.events).toBe(HEAD);
    expect(JSON.parse(await file!.blob.text()).events).toHaveLength(HEAD);
  });

  it('gives up when a later page stays busy', async () => {
    const { fetchPage } = engine();
    const real = fetchPage.getMockImplementation()!;
    fetchPage.mockImplementation(async (f, c) => {
      if (c) throw new WhiteRoomApiError('HTTP 429', 429);
      return real(f, c);
    });
    await expect(buildAuditExport('f1', () => {}, { fetchPage, wait: async () => {} })).rejects.toThrow('HTTP 429');
    expect(fetchPage).toHaveBeenCalledTimes(1 + 4);
  });

  it('stops with an error when the pages stop moving forward', async () => {
    const stuck = vi.fn(async (): Promise<Page> => ({ fleetId: 'f1', firstSeq: 1, toSeq: HEAD, fromSeq: 1, events: [event(1)], nextFromSeq: 1 }));
    await expect(buildAuditExport('f1', () => {}, { fetchPage: stuck })).rejects.toThrow('stopped moving forward');
    expect(stuck).toHaveBeenCalledTimes(1);
    const beyond = vi.fn(async (): Promise<Page> => ({ fleetId: 'f1', firstSeq: 1, toSeq: 10, fromSeq: 1, events: [event(1)], nextFromSeq: 11 }));
    await expect(buildAuditExport('f1', () => {}, { fetchPage: beyond })).rejects.toThrow('stopped moving forward');
  });

  /** A fake engine whose pages are changed by `tamper` before they're returned. */
  function tampered(tamper: (p: Page) => Page, size = 500) {
    const { fetchPage } = engine(size);
    const real = fetchPage.getMockImplementation()!;
    return vi.fn(async (f: string, c?: { fromSeq: number; toSeq: number }) => tamper(await real(f, c)));
  }

  it('refuses a short page that skips ahead', async () => {
    // The engine says the next page starts at 501, but sent only 499 events.
    const fetchPage = tampered((p) => (p.fromSeq === 1 ? { ...p, events: p.events.slice(0, -1) } : p));
    await expect(buildAuditExport('f1', () => {}, { fetchPage })).rejects.toThrow('stopped moving forward');
  });

  it('refuses an empty page that says there is more', async () => {
    const fetchPage = tampered((p) => (p.fromSeq === 501 ? { ...p, events: [] } : p));
    await expect(buildAuditExport('f1', () => {}, { fetchPage })).rejects.toThrow('stopped moving forward');
  });

  it('refuses a missing event in the middle of a page', async () => {
    const fetchPage = tampered((p) => (p.fromSeq === 501 ? { ...p, events: p.events.filter((e) => e.seq !== 700) } : p));
    await expect(buildAuditExport('f1', () => {}, { fetchPage })).rejects.toThrow('missing events');
  });

  it('refuses a file whose first event isn’t where it should start', async () => {
    const fetchPage = tampered((p) => (p.fromSeq === 1 ? { ...p, events: p.events.slice(1) } : p));
    await expect(buildAuditExport('f1', () => {}, { fetchPage })).rejects.toThrow('missing events');
  });

  it('refuses a signature for a different head', async () => {
    const fetchPage = tampered((p) => (p.manifest ? { ...p, manifest: { ...p.manifest, headSeq: HEAD + 1 } } : p));
    await expect(buildAuditExport('f1', () => {}, { fetchPage })).rejects.toThrow('doesn’t match its signature');
  });

  it('refuses a last event whose content isn’t the one signed for', async () => {
    const fetchPage = tampered((p) => (p.manifest ? { ...p, events: p.events.map((e) => (e.seq === HEAD ? { ...e, hash: 'swapped' } : e)) } : p));
    await expect(buildAuditExport('f1', () => {}, { fetchPage })).rejects.toThrow('doesn’t match its signature');
  });

  it('refuses a signature for a different count', async () => {
    const fetchPage = tampered((p) => (p.manifest ? { ...p, manifest: { ...p.manifest, count: HEAD - 1 } } : p));
    await expect(buildAuditExport('f1', () => {}, { fetchPage })).rejects.toThrow('doesn’t match its signature');
  });

  it('matches a history that starts after seq 1', async () => {
    const { fetchPage, calls } = engine(500, 100);
    const file = await buildAuditExport('f1', () => {}, { fetchPage });
    expect(calls).toEqual([undefined, { fromSeq: 600, toSeq: HEAD }, { fromSeq: 1100, toSeq: HEAD }]);
    expect(file!.events).toBe(HEAD - 99);
    expect(JSON.parse(await file!.blob.text()).events[0].seq).toBe(100);
  });

  it('stops waiting to retry as soon as it is cancelled', async () => {
    let cancel = false;
    const busy = vi.fn(async () => { throw new WhiteRoomApiError('HTTP 429', 429); });
    const wait = vi.fn(async (_ms: number) => { if (wait.mock.calls.length === 3) cancel = true; });
    const file = await buildAuditExport('f1', () => {}, { fetchPage: busy, wait, isCancelled: () => cancel });
    expect(file).toBeNull();
    expect(busy).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledTimes(3); // well short of the 5 s wait
  });

  it('falls back to the older export for a fleet with no stored events (the engine answers 409)', async () => {
    client.signed.mockResolvedValueOnce({ fleetId: 'f1', entries: [], signature: 'old' });
    const none = vi.fn(async () => { throw new WhiteRoomApiError('HTTP 409', 409, 'This fleet has no stored history yet.'); });
    const file = await buildAuditExport('f1', () => {}, { fetchPage: none });
    expect(file!.events).toBeNull();
    expect(client.signed).toHaveBeenCalledTimes(1);
  });

  it('saves an empty, signed file when the signed history is empty', async () => {
    const empty = vi.fn(async (): Promise<Page> => ({
      fleetId: 'f1', firstSeq: 1, toSeq: 0, fromSeq: 1, events: [], nextFromSeq: null,
      manifest: { format: 'whiteroom-audit-export', firstSeq: 1, headSeq: 0, headHash: null, count: 0, signature: 'sig' },
    }));
    const progress: Array<[number, number]> = [];
    const file = await buildAuditExport('f1', (d, t) => progress.push([d, t]), { fetchPage: empty });
    expect(file!.events).toBe(0);
    const parsed = JSON.parse(await file!.blob.text());
    expect(parsed.events).toEqual([]);
    expect(parsed.manifest).toMatchObject({ count: 0, signature: 'sig' });
    expect(progress).toEqual([[0, 0]]);
    expect(client.signed).not.toHaveBeenCalled();
  });

  it('still refuses an empty file whose signature counts events', async () => {
    const empty = vi.fn(async (): Promise<Page> => ({
      fleetId: 'f1', firstSeq: 1, toSeq: 0, fromSeq: 1, events: [], nextFromSeq: null,
      manifest: { format: 'whiteroom-audit-export', firstSeq: 1, headSeq: 0, headHash: null, count: 3, signature: 'sig' },
    }));
    await expect(buildAuditExport('f1', () => {}, { fetchPage: empty })).rejects.toThrow('doesn’t match its signature');
  });

  it('stops when a later page is for a different head than the first pinned', async () => {
    const { fetchPage } = engine();
    const real = fetchPage.getMockImplementation()!;
    fetchPage.mockImplementation(async (f, c) => {
      const p = await real(f, c);
      return c?.fromSeq === 501 ? { ...p, toSeq: HEAD + 50 } : p;
    });
    await expect(buildAuditExport('f1', () => {}, { fetchPage })).rejects.toThrow('changed part-way through');
    // Asked for the pinned head every time, and stopped at the page that changed it.
    expect(fetchPage.mock.calls.map(([, c]) => c)).toEqual([undefined, { fromSeq: 501, toSeq: HEAD }]);
  });
});
