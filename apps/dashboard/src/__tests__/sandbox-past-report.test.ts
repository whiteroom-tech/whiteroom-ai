// Past tests › Download report: an ended test's report, as the engine kept it
// (sandbox_report), in the same format as the live download. The end-test
// dialog drops "only while the test is open" once the engine keeps reports.

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
const { reportsKept } = await import('@/lib/sandbox/api');
const { buildTestReport, pastTestReport, reportHtml } = await import('@/lib/sandbox/report');
const { PastTestDetail } = await import('@/components/sandbox/PastTests');
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
});

describe('End this test?', () => {
  it('knows reports are kept once the engine marks its past tests', () => {
    expect(reportsKept(undefined)).toBe(false);
    expect(reportsKept([test])).toBe(false);
    expect(reportsKept([test, { ...test, sandboxId: 'sb2', hasReport: false }])).toBe(true);
  });

  it('drops “only while the test is open” when reports are kept', () => {
    expect(endTestText(false)).toContain('can only be downloaded while the test is open');
    expect(endTestText(true)).not.toContain('only be downloaded');
    expect(endTestText(true)).toContain('The result and its report stay in Past tests.');
  });
});
