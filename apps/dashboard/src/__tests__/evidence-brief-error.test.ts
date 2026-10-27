// @vitest-environment happy-dom
// The implementation brief on a recommendation's evidence: a failed Copy or
// Download says so, an empty brief counts as a failure, and the note clears
// on the next try.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ exportBrief: vi.fn(), get: vi.fn() }));
vi.mock('@/lib/whiteroom/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/whiteroom/client')>()),
  performanceRecommendationExport: api.exportBrief,
  performanceRecommendationGet: api.get,
}));
const { AgentView, EvidenceView } = await import('@/app/(citadel)/performance/_components/AgentEvidence');

const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
const writeText = vi.fn();

beforeEach(() => {
  api.get.mockResolvedValue({
    recommendation: { id: 'rec_1', detector: 'review_cache_behavior', agentId: 'lead-agent', source: 'engine', cohort: 'all', action: 'Turn on caching', status: 'open', verificationStatus: 'pending', currentFindingId: 'f_1', feedbackCount: 0, createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z' },
    finding: null, feedback: [],
  });
  writeText.mockReset();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
});
afterEach(() => { api.exportBrief.mockReset(); api.get.mockReset(); });

async function mount() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(h(EvidenceView, { data: { finding: null, calls: [] }, fleetId: 'f1', recommendationId: 'rec_1', authKey: 'k' })); });
  await flush();
  const button = (label: string) => [...el.querySelectorAll('button')].find((b) => b.textContent === label)!;
  const click = async (label: string) => { await act(async () => { button(label).click(); }); await flush(); };
  const alert = () => el.querySelector('[role="alert"]')?.textContent ?? null;
  const labels = () => [...el.querySelectorAll('button')].map((b) => b.textContent);
  return { root, click, alert, labels };
}

describe('Implementation brief errors', () => {
  it('shows a note when the request fails, and clears it on the next try', async () => {
    api.exportBrief.mockRejectedValueOnce(new Error('down'));
    const m = await mount();
    await m.click('Copy implementation brief');
    expect(m.alert()).toBe('Couldn’t copy the brief. Try again.');
    api.exportBrief.mockResolvedValueOnce({ markdown: '# Brief' });
    writeText.mockResolvedValueOnce(undefined);
    await m.click('Copy implementation brief');
    expect(writeText).toHaveBeenCalledWith('# Brief');
    expect(m.alert()).toBeNull();
    m.root.unmount();
  });

  it('shows a note when the clipboard write fails', async () => {
    api.exportBrief.mockResolvedValueOnce({ markdown: '# Brief' });
    writeText.mockRejectedValueOnce(new Error('denied'));
    const m = await mount();
    await m.click('Copy implementation brief');
    expect(m.alert()).toBe('Couldn’t copy the brief. Try again.');
    m.root.unmount();
  });

  it('counts an empty brief as a failure', async () => {
    api.exportBrief.mockResolvedValueOnce({ markdown: '' });
    const m = await mount();
    await m.click('Download as Markdown');
    expect(m.alert()).toBe('Couldn’t download the brief. Try again.');
    m.root.unmount();
  });

  it('drops "Copied" when a later try fails', async () => {
    api.exportBrief.mockResolvedValueOnce({ markdown: '# Brief' });
    writeText.mockResolvedValueOnce(undefined);
    const m = await mount();
    await m.click('Copy implementation brief');
    expect(m.labels()).toContain('Copied');
    api.exportBrief.mockRejectedValueOnce(new Error('down'));
    await m.click('Copied');
    expect(m.labels()).not.toContain('Copied');
    expect(m.labels()).toContain('Copy implementation brief');
    expect(m.alert()).toBe('Couldn’t copy the brief. Try again.');
    m.root.unmount();
  });
});

describe('Agent performance cards', () => {
  // The engine's avgLatencyMs is the median (p50), so the card says Typical, not Average.
  it('labels the median call time "Typical response"', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(h(AgentView, { data: {
      fleetId: 'f1', agentId: 'lead-agent', period: { start: '2026-10-26T00:00:00Z', end: '2026-10-27T00:00:00Z' }, hourly: [],
      totals: { calls: 12, costMicros: 120_000, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, errorRate: 0, avgLatencyMs: 1900 },
    } as never })); });
    const text = (el.textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toMatch(/Typical response\s*1\.9s/);
    expect(text).not.toContain('Average response');
    root.unmount();
  });
});
