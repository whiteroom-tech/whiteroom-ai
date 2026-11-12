// The signed call log as the dashboard builds it: pages followed to the end
// by their signed state, one file with every call and the signed manifest,
// retries on a busy engine, and plain refusals.
import { describe, expect, it, vi } from 'vitest';

const { buildCallExport, CallExportRefused, CALL_EXPORT_UNAVAILABLE } = await import('@/lib/call-export');
const { ControlDeniedError, WhiteRoomApiError } = await import('@/lib/whiteroom/client');
type Page = import('@/lib/whiteroom/types').CallExportPage;
type Ask = Parameters<import('@/lib/call-export').FetchCallPage>[1];

const call = (n: number) => ({ callId: `c${n}`, agentId: 'lead', outcome: 'complete' });

/** A fake engine: `total` calls in pages of `size`, the manifest on the last. */
function engine(total: number, size = 2) {
  const asks: Ask[] = [];
  const fetchPage = vi.fn(async (_fleet: string, ask: Ask): Promise<Page> => {
    asks.push(ask);
    const from = 'state' in ask ? (ask.state.count as number) : 0;
    const upTo = Math.min(total, from + size);
    const calls = Array.from({ length: upTo - from }, (_, i) => call(from + i + 1));
    return upTo < total
      ? { fleetId: 'f1', calls, count: upTo, state: { kind: 'call-export-state', count: upTo, signature: 'state-sig' } }
      : { fleetId: 'f1', calls, count: upTo, state: null, manifest: { format: 'whiteroom-call-export', count: total, digest: 'd', signature: 'sig' } };
  });
  return { fetchPage, asks };
}
const scope = { fromDay: '2026-11-01', toDay: '2026-11-07' };

describe('signed call log', () => {
  it('follows every page by its state into one file with all calls in order and the signed manifest', async () => {
    const { fetchPage, asks } = engine(5);
    const progress: number[] = [];
    const file = await buildCallExport('f1', scope, (d) => progress.push(d), { fetchPage });
    expect(asks).toEqual([scope, { state: expect.objectContaining({ count: 2 }) }, { state: expect.objectContaining({ count: 4 }) }]);
    expect(file!.calls).toBe(5);
    const parsed = JSON.parse(await file!.blob.text());
    expect(parsed).toMatchObject({ format: 'whiteroom-call-export', version: 1, fleetId: 'f1' });
    expect(parsed.calls).toEqual([1, 2, 3, 4, 5].map(call));
    expect(parsed.manifest).toEqual({ format: 'whiteroom-call-export', count: 5, digest: 'd', signature: 'sig' });
    expect(progress).toEqual([2, 4, 5]);
  });

  it('saves a signed, empty file when there were no calls', async () => {
    const file = await buildCallExport('f1', { runId: 'lead~7' }, () => {}, { fetchPage: engine(0).fetchPage });
    expect(JSON.parse(await file!.blob.text())).toMatchObject({ calls: [], manifest: { count: 0, signature: 'sig' } });
  });

  it('waits and tries again when the engine is busy, and stops when cancelled', async () => {
    const { fetchPage } = engine(3);
    fetchPage.mockRejectedValueOnce(new WhiteRoomApiError('HTTP 503', 503));
    const wait = vi.fn(async (_ms: number) => {});
    expect((await buildCallExport('f1', scope, () => {}, { fetchPage, wait }))!.calls).toBe(3);
    expect(wait).toHaveBeenCalled();
    let pages = 0;
    const stopped = await buildCallExport('f1', scope, () => { pages++; }, { fetchPage: engine(9).fetchPage, isCancelled: () => pages >= 2 });
    expect(stopped).toBeNull();
  });

  it('refuses plainly: too many calls, not the owner, or an engine without it', async () => {
    const refusal = async (e: Error) => buildCallExport('f1', scope, () => {}, { fetchPage: vi.fn().mockRejectedValue(e) }).catch((x) => x);
    const tooMany = "That's too many calls for one file. Pick fewer days or one agent.";
    expect(await refusal(new WhiteRoomApiError('HTTP 400', 400, tooMany))).toMatchObject({ name: 'CallExportRefused', plain: tooMany });
    expect(await refusal(new ControlDeniedError('Only this fleet’s owner can download its signed log.'))).toMatchObject({ plain: 'Only this fleet’s owner can download its signed log.' });
    expect(await refusal(new WhiteRoomApiError('HTTP 400', 400, 'Unknown action.'))).toMatchObject({ plain: CALL_EXPORT_UNAVAILABLE });
    expect(await refusal(new WhiteRoomApiError('HTTP 403', 403, 'This action is only available from the WhiteRoom dashboard.'))).toMatchObject({ plain: CALL_EXPORT_UNAVAILABLE });
    // Anything else is an ordinary failure.
    expect(await refusal(new WhiteRoomApiError('HTTP 400', 400, 'from_day must be YYYY-MM-DD.'))).not.toBeInstanceOf(CallExportRefused);
    expect(await refusal(new WhiteRoomApiError('HTTP 500', 500))).not.toBeInstanceOf(CallExportRefused);
  });

  it('saves nothing when the pages don’t add up to what was signed', async () => {
    const short = engine(4);
    const real = short.fetchPage.getMockImplementation()!;
    // A page that lost a call on the way.
    short.fetchPage.mockImplementation(async (f, ask) => { const p = await real(f, ask); return 'state' in ask ? { ...p, calls: p.calls.slice(1) } : p; });
    await expect(buildCallExport('f1', scope, () => {}, { fetchPage: short.fetchPage })).rejects.toThrow(/missing calls/);
    // A last page without its manifest, or signed for another count.
    const bare = engine(1);
    const realBare = bare.fetchPage.getMockImplementation()!;
    bare.fetchPage.mockImplementation(async (f, ask) => ({ ...(await realBare(f, ask)), manifest: undefined }));
    await expect(buildCallExport('f1', scope, () => {}, { fetchPage: bare.fetchPage })).rejects.toThrow(/signature/);
    const off = engine(1);
    const realOff = off.fetchPage.getMockImplementation()!;
    off.fetchPage.mockImplementation(async (f, ask) => { const p = await realOff(f, ask); return { ...p, manifest: { ...p.manifest!, count: 2 } }; });
    await expect(buildCallExport('f1', scope, () => {}, { fetchPage: off.fetchPage })).rejects.toThrow(/signature/);
    // A page that brings nothing but says there is more.
    const stuck = vi.fn(async (): Promise<Page> => ({ fleetId: 'f1', calls: [], count: 0, state: { kind: 'call-export-state' } }));
    await expect(buildCallExport('f1', scope, () => {}, { fetchPage: stuck })).rejects.toThrow(/moving forward/);
  });
});
