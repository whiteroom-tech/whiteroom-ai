// Past tests › Download report: an ended test's report, as the engine kept it
// (sandbox_report), in the same format as the live download. The end-test
// dialog drops "only while the test is open" when status says reportsKept.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RunStatusResult } from '@/lib/sandbox/api';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/whiteroom/client', () => ({ PROXY_URL: 'https://proxy.example.test' }));
vi.mock('@/lib/fleet-session', () => ({ getFleetAuthCookie: async () => null, tokenFromUserFleets: async () => null }));
vi.mock('@/lib/analytics', () => ({ analytics: { capture: () => {} } }));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null, status: 'unauthenticated' }) }));
const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const { GET } = await import('@/app/api/sandbox/[sandboxId]/report/route');
const { buildTestReport, pastTestReport, reportFileName, reportHtml } = await import('@/lib/sandbox/report');
const { DOWNLOAD_IDLE, DownloadReport, PastTestDetail, startDownload } = await import('@/components/sandbox/PastTests');
type DownloadState = import('@/components/sandbox/PastTests').DownloadState;
const { endTestText } = await import('@/components/sandbox/TestRunFlow');

const NOW = Date.parse('2026-10-13T12:00:00Z');
const ended: RunStatusResult = {
  sandboxId: 'sb1', isTrial: false, provider: null,
  agents: [{ agentId: 'support-bot', role: 'worker', status: 'active', watchMinutes: 2, watchCount: 1, totalTasks: 3, totalTokens: 900, pairedWith: null, currentWatch: null }],
  controls: [{ controlId: 'core.connect', name: 'Connect', result: { liveEvidence: { status: 'observed', timestamp: '2026-10-13T11:00:00Z' } } }] as unknown as RunStatusResult['controls'],
  auditLog: [{ id: 'e1', timestamp: '2026-10-13T11:00:00Z', type: 'register', agentId: 'support-bot' }],
};
const test = { sandboxId: 'sb1', destroyedAt: '2026-10-13T11:30:00Z', overall: 'partial' as const, totalTasks: 3, isTrial: false };

describe('GET /api/sandbox/[id]/report', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('WR_SANDBOX_SERVICE_SECRET', 'placeholder-service-secret');
    mockAuth.mockResolvedValue({ user: { id: 'u1' } });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  const get = (id: string) => GET(new Request(`https://app.example.test/api/sandbox/${id}/report`), { params: Promise.resolve({ sandboxId: id }) });

  it('asks the engine for this owner’s report and passes it through', async () => {
    const body = { success: true, sandboxId: 'sb1', destroyedAt: test.destroyedAt, overall: 'partial', report: ended };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));
    const res = await get('sb1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(body);
    // Per-user data: never cached (every sandbox route goes through toResponse).
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ action: 'sandbox_report', user_id: 'dashboard:u1', sandbox_id: 'sb1' });
  });

  it('passes the engine’s refusal through, and refuses bad ids and signed-out users itself', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'No report was kept for this test.' }), { status: 404 }));
    expect((await get('sb1')).status).toBe(404);
    expect((await get('../x')).status).toBe(400);
    mockAuth.mockResolvedValue(null);
    expect((await get('sb1')).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('the kept report', () => {
  it('is the live download’s format, built from the status as it ended', () => {
    const r = pastTestReport({ report: ended }, 'sb1', NOW);
    expect(r).toEqual(buildTestReport({ ...ended, mode: 'connected' }, NOW));
    expect(r?.testId).toBe('sb1');
    expect(r?.calls).toBe(3);
    expect(reportHtml(r!)).toContain('support-bot');
  });

  it('is dated when the test ended, not when it was downloaded', () => {
    const r = pastTestReport({ report: { ...ended, endedAt: '2026-10-01T09:15:00.000Z' } }, 'sb1', NOW);
    expect(r?.generatedAt).toBe('2026-10-01T09:15:00.000Z');
    expect(reportFileName(r!)).toBe('whiteroom-test-report-2026-10-01-sb1.html');
    // Without endedAt in the report, the row's end time; without either, now.
    expect(pastTestReport({ report: ended, destroyedAt: '2026-10-02T08:00:00.000Z' }, 'sb1', NOW)?.generatedAt).toBe('2026-10-02T08:00:00.000Z');
    expect(pastTestReport({ report: { ...ended, endedAt: 'garbage' } }, 'sb1', NOW)?.generatedAt).toBe(new Date(NOW).toISOString());
    // A malformed endedAt doesn't hide a good destroyedAt.
    expect(pastTestReport({ report: { ...ended, endedAt: 'garbage' }, destroyedAt: '2026-10-02T08:00:00.000Z' }, 'sb1', NOW)?.generatedAt).toBe('2026-10-02T08:00:00.000Z');
  });

  it('is nothing when the engine kept none', () => {
    expect(pastTestReport({}, 'sb1')).toBeNull();
  });

  it('is a demo when the test was one', () => {
    expect(pastTestReport({ report: { ...ended, isTrial: true } }, 'sb1', NOW)?.mode).toBe('demo');
  });
});

describe('Past tests row: Download report', () => {
  it('offers the download when the report was kept, instead of “aren’t kept”', () => {
    const html = renderToStaticMarkup(h(PastTestDetail, { test: { ...test, hasReport: true }, onClose: () => {} }));
    expect(html).toContain('>Download report</button>');
    expect(html).not.toContain('aren’t kept after a test ends');
  });

  it('keeps the old note for tests that kept no report', () => {
    for (const t of [test, { ...test, hasReport: false }]) {
      const html = renderToStaticMarkup(h(PastTestDetail, { test: t, onClose: () => {} }));
      expect(html).not.toContain('Download report');
      expect(html).toContain('aren’t kept after a test ends');
    }
  });

  const render = (state: DownloadState) => renderToStaticMarkup(h(DownloadReport, { state, onClick: () => {} }));
  it('stays focusable while saving: aria-disabled, never disabled', () => {
    const saving = render({ saving: true, outcome: null });
    expect(saving).toContain('aria-disabled="true"');
    expect(saving).not.toMatch(/\sdisabled=""/);
    expect(saving).toContain('Downloading…');
    expect(render(DOWNLOAD_IDLE)).not.toContain('aria-disabled');
  });

  it('announces the outcome politely', () => {
    expect(render(DOWNLOAD_IDLE)).toMatch(/aria-live="polite"[^>]*><\/p>/);
    expect(render({ saving: false, outcome: 'saved' })).toMatch(/aria-live="polite"[^>]*>Report downloaded\.<\/p>/);
    expect(render({ saving: false, outcome: 'failed' })).toMatch(/aria-live="polite"[^>]*>Couldn’t get this report\. Try again\.<\/p>/);
  });

  it('a click saves, then says saved', async () => {
    const states: DownloadState[] = [];
    const save = vi.fn(async () => {});
    await startDownload(DOWNLOAD_IDLE, save, (st) => states.push(st));
    expect(save).toHaveBeenCalledTimes(1);
    expect(states).toEqual([{ saving: true, outcome: null }, { saving: false, outcome: 'saved' }]);
  });

  it('a failed save says so, and a retry clears it', async () => {
    const states: DownloadState[] = [];
    await startDownload(DOWNLOAD_IDLE, async () => { throw new Error('No report'); }, (st) => states.push(st));
    expect(states.at(-1)).toEqual({ saving: false, outcome: 'failed' });
    await startDownload(states.at(-1)!, async () => {}, (st) => states.push(st));
    expect(states.slice(-2)).toEqual([{ saving: true, outcome: null }, { saving: false, outcome: 'saved' }]);
  });

  it('ignores clicks while a download is in progress', () => {
    const save = vi.fn(async () => {});
    const set = vi.fn();
    expect(startDownload({ saving: true, outcome: null }, save, set)).toBeNull();
    expect(save).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });
});

describe('End this test?', () => {
  it('drops “only while the test is open” when status says reportsKept', () => {
    expect(endTestText({ reportsKept: true })).not.toContain('only be downloaded');
    expect(endTestText({ reportsKept: true })).toContain('The result and its report stay in Past tests.');
  });

  it('keeps the warning for an engine that doesn’t say so', () => {
    for (const run of [null, {}, { reportsKept: false }]) {
      expect(endTestText(run)).toContain('can only be downloaded while the test is open');
    }
  });
});
