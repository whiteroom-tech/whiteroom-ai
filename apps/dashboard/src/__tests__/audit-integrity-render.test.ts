// @vitest-environment happy-dom
// Settings › Audit integrity in a DOM: the coverage headline, and a check's
// note is green only when every event checked out.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const auth = vi.hoisted(() => ({ fleetId: 'f1' }));
vi.mock('@/hooks/useFleetAuth', () => ({ useFleetAuth: () => ({ status: 'authenticated', fleetId: auth.fleetId }) }));
const api = vi.hoisted(() => ({ verify: vi.fn(), build: vi.fn(), save: vi.fn() }));
vi.mock('@/lib/audit-export', () => ({ buildAuditExport: api.build, saveBlob: api.save }));
vi.mock('@/lib/whiteroom/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/whiteroom/client')>()),
  auditIntegrity: async () => ({ fleetId: 'f1', mode: 'sequenced', headSeq: 2045, verifiedThroughSeq: 939, verifiedAt: new Date(Date.now() - 3600_000).toISOString(), prunedBeforeTracking: false, legacyEvents: 0, gaps: { count: 0, recent: [] }, anchoring: { enabled: false } }),
  verifyAudit: api.verify,
}));

const { AuditIntegritySection } = await import('@/components/settings/AuditIntegritySection');
const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });

async function mount() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(h(AuditIntegritySection)); });
  await flush();
  const run = async () => { await act(async () => { ([...el.querySelectorAll('button')].find((b) => b.textContent === 'Run check now') as HTMLButtonElement).click(); }); await flush(); };
  const note = () => el.querySelector('[role="status"]') as HTMLElement | null;
  return { el, root, run, note };
}

beforeEach(() => { auth.fleetId = 'f1'; api.verify.mockReset(); api.build.mockReset(); api.save.mockReset(); });

describe('audit integrity', () => {
  it('leads with coverage, never a pass below 100%', async () => {
    const m = await mount();
    expect(m.el.textContent).toContain('939 of 2,045 events checked (45%)');
    expect(m.el.textContent).toContain('Kept for at least 12 months on every plan.');
    m.root.unmount();
  });

  it('colours a check’s note by its result: green only when every event checked out', async () => {
    const m = await mount();
    api.verify.mockResolvedValueOnce({ valid: null, eventsVerified: 1000 });
    await m.run();
    expect(m.note()!.textContent).toBe('1,000 events checked so far. Run the check again to continue.');
    expect(m.note()!.style.color).toBe('var(--tx2)');
    api.verify.mockResolvedValueOnce({ valid: false, eventsVerified: 12, message: 'Event e1 does not match its recorded hash.' });
    await m.run();
    expect(m.note()!.style.color).toBe('var(--bad)');
    api.verify.mockResolvedValueOnce({ valid: true, eventsVerified: 2045 });
    await m.run();
    expect(m.note()!.style.color).toBe('var(--ok)');
    m.root.unmount();
  });

  it('downloads the whole history, counting events as they come in', async () => {
    const m = await mount();
    let finish!: (v: unknown) => void;
    let report!: (done: number, total: number) => void;
    api.build.mockImplementationOnce((_id: string, onProgress: typeof report) => { report = onProgress; return new Promise((r) => { finish = r; }); });
    const button = () => [...m.el.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Download') || b.textContent?.startsWith('Preparing')) as HTMLButtonElement;
    await act(async () => { button().click(); });
    await flush();
    expect(api.build).toHaveBeenCalledWith('f1', expect.any(Function), expect.objectContaining({ isCancelled: expect.any(Function) }));
    expect(button().textContent).toContain('Preparing…');
    await act(async () => { report(5000, 12345); });
    expect(button().textContent).toContain('Preparing… 5,000 of 12,345 events');
    const blob = new Blob(['{}']);
    await act(async () => { finish({ blob, events: 12345 }); });
    await flush();
    expect(api.save).toHaveBeenCalledWith(blob, expect.stringMatching(/^whiteroom-audit-f1-\d{4}-\d{2}-\d{2}\.json$/));
    expect(m.note()!.textContent).toBe('Downloaded 12,345 events, signed by WhiteRoom.');
    expect(button().textContent).toBe('Download signed export');
    m.root.unmount();
  });

  it('says so when the download fails', async () => {
    const m = await mount();
    api.build.mockRejectedValueOnce(new Error('HTTP 500'));
    await act(async () => { ([...m.el.querySelectorAll('button')].find((b) => b.textContent === 'Download signed export') as HTMLButtonElement).click(); });
    await flush();
    expect(api.save).not.toHaveBeenCalled();
    expect(m.note()!.textContent).toBe('The export didn’t download. Try again.');
    m.root.unmount();
  });

  /** Starts a download that waits for the test to report progress and finish it. */
  async function startDownload(m: Awaited<ReturnType<typeof mount>>) {
    const ctl = {} as { finish: (v: unknown) => void; report: (done: number, total: number) => void; isCancelled: () => boolean };
    api.build.mockImplementationOnce((_id: string, onProgress: typeof ctl.report, opts: { isCancelled: () => boolean }) => {
      ctl.report = onProgress;
      ctl.isCancelled = opts.isCancelled;
      return new Promise((r) => { ctl.finish = r; });
    });
    await act(async () => { ([...m.el.querySelectorAll('button')].find((b) => b.textContent === 'Download signed export') as HTMLButtonElement).click(); });
    await flush();
    return ctl;
  }

  it('saves nothing and stops counting when the fleet changes mid-export', async () => {
    const m = await mount();
    const ctl = await startDownload(m);
    expect(ctl.isCancelled()).toBe(false);
    auth.fleetId = 'f2';
    await act(async () => { m.root.render(h(AuditIntegritySection)); });
    await flush();
    expect(ctl.isCancelled()).toBe(true);
    await act(async () => { ctl.report(5000, 12345); });
    expect(m.el.textContent).not.toContain('5,000 of 12,345');
    await act(async () => { ctl.finish({ blob: new Blob(['{}']), events: 12345 }); });
    await flush();
    expect(api.save).not.toHaveBeenCalled();
    expect(m.note()).toBeNull();
    m.root.unmount();
  });

  it('saves nothing when the page is left mid-export', async () => {
    const m = await mount();
    const ctl = await startDownload(m);
    m.root.unmount();
    expect(ctl.isCancelled()).toBe(true);
    await act(async () => { ctl.report(5000, 12345); ctl.finish({ blob: new Blob(['{}']), events: 12345 }); });
    await flush();
    expect(api.save).not.toHaveBeenCalled();
  });

  it('saves the older export from an older engine without a count note', async () => {
    const m = await mount();
    const ctl = await startDownload(m);
    const blob = new Blob(['{}']);
    await act(async () => { ctl.finish({ blob, events: null }); });
    await flush();
    expect(api.save).toHaveBeenCalledWith(blob, expect.any(String));
    expect(m.note()).toBeNull();
    m.root.unmount();
  });
});
