// @vitest-environment happy-dom
// Settings › Audit integrity in a DOM: the coverage headline, and a check's
// note is green only when every event checked out.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const auth = vi.hoisted(() => ({ fleetId: 'f1' as string | null, status: 'authenticated' }));
vi.mock('@/hooks/useFleetAuth', () => ({ useFleetAuth: () => ({ status: auth.status, fleetId: auth.fleetId }) }));
const api = vi.hoisted(() => ({ verify: vi.fn(), build: vi.fn(), save: vi.fn(), integrity: vi.fn() }));
vi.mock('@/lib/audit-export', async (orig) => ({ ...(await orig<typeof import('@/lib/audit-export')>()), buildAuditExport: api.build }));
vi.mock('@/lib/download', () => ({ saveBlob: api.save }));
const INFO = () => ({ fleetId: 'f1', mode: 'sequenced', headSeq: 2045, verifiedThroughSeq: 939, verifiedAt: new Date(Date.now() - 3600_000).toISOString(), prunedBeforeTracking: false, legacyEvents: 0, gaps: { count: 0, recent: [] }, anchoring: { enabled: false } });
vi.mock('@/lib/whiteroom/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/whiteroom/client')>()),
  auditIntegrity: api.integrity,
  verifyAudit: api.verify,
}));

const { AuditIntegritySection } = await import('@/components/settings/AuditIntegritySection');
const { AuditExportProblem } = await import('@/lib/audit-export');
const { WhiteRoomApiError } = await import('@/lib/whiteroom/client');
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

beforeEach(() => {
  auth.fleetId = 'f1'; auth.status = 'authenticated';
  api.verify.mockReset(); api.build.mockReset(); api.save.mockReset();
  api.integrity.mockReset(); api.integrity.mockImplementation(async () => INFO());
});
const downloadButton = (el: HTMLElement) => [...el.querySelectorAll('button')].find((b) => b.textContent === 'Download signed export') as HTMLButtonElement;

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
    await act(async () => { downloadButton(m.el).click(); });
    await flush();
    expect(api.build).toHaveBeenCalledWith('f1', expect.any(Function), expect.objectContaining({ isCancelled: expect.any(Function) }));
    // The button keeps its label (and width); progress is its own status line.
    expect(downloadButton(m.el).disabled).toBe(true);
    const progress = () => m.el.querySelector('.wr-audit-progress');
    expect(progress()!.getAttribute('role')).toBe('status');
    expect(progress()!.textContent).toBe('Preparing…');
    await act(async () => { report(5000, 12345); });
    expect(progress()!.textContent).toBe('Preparing… 5,000 of 12,345 events');
    const blob = new Blob(['{}']);
    await act(async () => { finish({ blob, events: 12345 }); });
    await flush();
    expect(api.save).toHaveBeenCalledWith(blob, expect.stringMatching(/^whiteroom-audit-f1-\d{4}-\d{2}-\d{2}\.json$/));
    expect(progress()).toBeNull();
    expect(m.note()!.textContent).toBe('Downloaded 12,345 events, signed by WhiteRoom.');
    expect(m.note()!.style.color).toBe('var(--ok)');
    expect(downloadButton(m.el).disabled).toBe(false);
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

  it('a history that doesn’t add up is a problem with the audit trail, not a retry, and offers a check', async () => {
    const m = await mount();
    api.build.mockRejectedValueOnce(new AuditExportProblem('The export is missing events.', 'some events are missing'));
    await act(async () => { downloadButton(m.el).click(); });
    await flush();
    expect(api.save).not.toHaveBeenCalled();
    expect(m.note()!.textContent).toBe('The export found a problem with the audit trail: some events are missing. Run check now.');
    expect(m.note()!.style.color).toBe('var(--bad)');
    expect(m.note()!.textContent).not.toContain('Try again');
    api.verify.mockResolvedValueOnce({ valid: true, eventsVerified: 2045 });
    await act(async () => { (m.note()!.querySelector('button') as HTMLButtonElement).click(); });
    await flush();
    expect(api.verify).toHaveBeenCalledWith('f1');
    m.root.unmount();
  });

  it('Cancel stops a download: nothing is saved and the button is free again', async () => {
    const m = await mount();
    const ctl = await startDownload(m);
    const cancel = [...m.el.querySelectorAll('button')].find((b) => b.textContent === 'Cancel') as HTMLButtonElement;
    await act(async () => { cancel.click(); });
    expect(ctl.isCancelled()).toBe(true);
    expect(m.el.querySelector('.wr-audit-progress')).toBeNull();
    expect([...m.el.querySelectorAll('button')].some((b) => b.textContent === 'Cancel')).toBe(false);
    expect(downloadButton(m.el).disabled).toBe(false);
    await act(async () => { ctl.finish({ blob: new Blob(['{}']), events: 3 }); });
    await flush();
    expect(api.save).not.toHaveBeenCalled();
    expect(m.note()).toBeNull();
    m.root.unmount();
  });

  it('is always there for a link to land on: sign in without a fleet, a loading line before the data', async () => {
    auth.status = 'unauthenticated'; auth.fleetId = null;
    let m = await mount();
    expect(m.el.textContent).toContain('Sign in to your fleet to download the audit trail.');
    m.root.unmount();
    auth.status = 'authenticated'; auth.fleetId = 'f1';
    api.integrity.mockImplementation(() => new Promise(() => {}));
    m = await mount();
    expect(m.el.textContent).toContain('Loading the audit trail…');
    m.root.unmount();
    api.integrity.mockRejectedValue(new Error('HTTP 503'));
    m = await mount();
    expect(m.el.textContent).toContain('Couldn’t load the audit trail.');
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

  it('saves the older export and says it holds only the most recent events', async () => {
    const m = await mount();
    const ctl = await startDownload(m);
    const blob = new Blob(['{}']);
    await act(async () => { ctl.finish({ blob, events: null }); });
    await flush();
    expect(api.save).toHaveBeenCalledWith(blob, expect.any(String));
    expect(m.note()!.textContent).toBe('Downloaded the shorter signed export, with the most recent events only.');
    m.root.unmount();
  });

  it('stays hidden on an engine without audit integrity, rather than asking for a reload', async () => {
    api.integrity.mockRejectedValueOnce(new WhiteRoomApiError('HTTP 400', 400, 'Unknown action.'));
    const m = await mount();
    expect(m.el.textContent).toBe('');
    m.root.unmount();
  });

  it('a failed load says so and offers a reload', async () => {
    api.integrity.mockRejectedValueOnce(new WhiteRoomApiError('HTTP 503', 503));
    const m = await mount();
    expect(m.el.textContent).toContain('Couldn’t load the audit trail. Reload the page to try again.');
    m.root.unmount();
  });

  it('a cancelled download finishing late leaves a newer one alone', async () => {
    const m = await mount();
    const first = await startDownload(m);
    auth.fleetId = 'f2';
    await act(async () => { m.root.render(h(AuditIntegritySection)); });
    await flush();
    // The new fleet's button is free straight away.
    const second = await startDownload(m);
    expect(first.isCancelled()).toBe(true);
    expect(second.isCancelled()).toBe(false);
    await act(async () => { second.report(10, 40); });
    // The old one ends late: it saves nothing and doesn't clear the new one's progress.
    await act(async () => { first.report(30, 40); first.finish({ blob: new Blob(['{}']), events: 40 }); });
    await flush();
    expect(api.save).not.toHaveBeenCalled();
    expect(m.el.textContent).toContain('Preparing… 10 of 40 events');
    const blob = new Blob(['{}']);
    await act(async () => { second.finish({ blob, events: 40 }); });
    await flush();
    expect(api.save).toHaveBeenCalledTimes(1);
    expect(api.save).toHaveBeenCalledWith(blob, expect.stringMatching(/^whiteroom-audit-f2-/));
    m.root.unmount();
  });

  it('an old download failing late shows no error for the new fleet', async () => {
    const m = await mount();
    let fail!: (e: Error) => void;
    api.build.mockImplementationOnce(() => new Promise((_r, j) => { fail = j; }));
    await act(async () => { ([...m.el.querySelectorAll('button')].find((b) => b.textContent === 'Download signed export') as HTMLButtonElement).click(); });
    auth.fleetId = 'f2';
    await act(async () => { m.root.render(h(AuditIntegritySection)); });
    await act(async () => { fail(new Error('HTTP 500')); });
    await flush();
    expect(m.note()).toBeNull();
    m.root.unmount();
  });
});
