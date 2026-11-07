// @vitest-environment happy-dom
// /sandbox: only "no fleet session" (401) opens the older connection test. A
// failed session check (502, network) is shown as one, with Try again.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const nav = vi.hoisted(() => ({ params: new URLSearchParams(), router: { replace: vi.fn(), push: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => nav.router, useSearchParams: () => nav.params, usePathname: () => '/sandbox' }));
vi.mock('@/components/sandbox/TestRunFlow', () => ({ TestRunFlow: () => h('div', null, 'LEGACY CONNECTION TEST') }));
vi.mock('@/components/sandbox/v2/SandboxHome', () => ({ SandboxHome: ({ fleet }: { fleet: string }) => h('div', null, `CURRENT SANDBOX ${fleet}`) }));
vi.mock('@/components/citadel/PageChrome', () => ({ PageHeader: () => null }));
const { SandboxEntry } = await import('@/components/sandbox/SandboxEntry');

let root: Root;
let el: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); });
async function mount() {
  el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el);
  await act(async () => root.render(h(SandboxEntry))); await flush();
}
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const tryAgain = () => [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Try again');

beforeEach(() => { nav.params = new URLSearchParams(); vi.clearAllMocks(); });
afterEach(async () => { if (root) await act(async () => root.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals(); });

it('a 502 shows a failed check with Try again, not the old flow; Try again then opens the Sandbox', async () => {
  const request = vi.fn()
    .mockResolvedValueOnce(json({ error: 'engine_unreachable', retryable: true }, 502))
    .mockResolvedValueOnce(json({ fleetId: 'fleet-a' }, 200));
  vi.stubGlobal('fetch', request);
  await mount();
  expect(el.textContent).not.toContain('LEGACY CONNECTION TEST');
  expect(el.textContent).toContain('Couldn’t load the Sandbox.');
  await act(async () => tryAgain()!.click()); await flush();
  expect(request).toHaveBeenCalledTimes(2);
  expect(el.textContent).toContain('CURRENT SANDBOX fleet-a');
});

it('a network failure is a failed check too', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
  await mount();
  expect(el.textContent).toContain('Couldn’t load the Sandbox.');
  expect(el.textContent).not.toContain('LEGACY CONNECTION TEST');
});

it('401 (no fleet session) keeps the older connection test', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'No fleet session.', signedIn: true }, 401)));
  await mount();
  expect(el.textContent).toBe('LEGACY CONNECTION TEST');
});

it('?connection=1 opens the connection test without checking the session', async () => {
  const request = vi.fn();
  vi.stubGlobal('fetch', request);
  nav.params = new URLSearchParams('connection=1');
  await mount();
  expect(el.textContent).toBe('LEGACY CONNECTION TEST');
  expect(request).not.toHaveBeenCalled();
});
