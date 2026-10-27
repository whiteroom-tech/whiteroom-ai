// @vitest-environment happy-dom
// Settings › Audit integrity in a DOM: the coverage headline, and a check's
// note is green only when every event checked out.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/hooks/useFleetAuth', () => ({ useFleetAuth: () => ({ status: 'authenticated', fleetId: 'f1' }) }));
const api = vi.hoisted(() => ({ verify: vi.fn() }));
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

beforeEach(() => api.verify.mockReset());

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
});
