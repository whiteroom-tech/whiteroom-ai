// @vitest-environment happy-dom
// Sandbox › End test, wired end to end: a live test asks first and calls
// nothing until confirmed.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, createElement as h, type FC } from 'react';
import { createRoot } from 'react-dom/client';
import type { RunStatusResult } from '@/lib/sandbox/api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null, status: 'unauthenticated' }) }));
vi.mock('@/lib/analytics', () => ({ analytics: { capture: () => {} } }));
const api = vi.hoisted(() => ({ destroy: vi.fn() }));
vi.mock('@/lib/sandbox/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/sandbox/api')>()),
  destroyRun: api.destroy,
  getHistory: async () => ({ sessions: [] }),
}));

const { TestRunFlow } = await import('@/components/sandbox/TestRunFlow');

const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
const run = (o: Partial<RunStatusResult>): RunStatusResult => ({ sandboxId: 'sb-1', mode: 'connected', expiresInSeconds: 1500, agents: [], auditLog: [], controls: [], ...o });

async function mount(previewRun: RunStatusResult) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(h(TestRunFlow as FC<NonNullable<Parameters<typeof TestRunFlow>[0]>>, { previewUserId: 'u', previewPastTests: [], previewRun, previewPractice: { fleet: null, rows: null, open: null } })); });
  await flush();
  const endButton = () => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'End test' && !b.closest('[role="alertdialog"]')) as HTMLButtonElement | undefined;
  return { el, root, endButton };
}

describe('End test', () => {
  beforeEach(() => { api.destroy.mockReset(); api.destroy.mockResolvedValue({ success: true }); document.body.innerHTML = ''; });

  it('asks first on a live test, and ends nothing until confirmed', async () => {
    const m = await mount(run({}));
    await act(async () => { m.endButton()!.click(); });
    await flush();
    expect(m.el.querySelector('[role="alertdialog"]')?.textContent).toContain('End this test?');
    expect(api.destroy).not.toHaveBeenCalled();
    m.root.unmount();
  });
});
