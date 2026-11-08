// @vitest-environment happy-dom
// One session check per page: every useFleetAuth under FleetAuthProvider
// shares the provider's GET /api/fleet/session (Settings' header and four
// fleet sections used to make one each), and an idle hook outside a provider
// (a preview) asks nothing.
import { afterEach, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { FleetAuthProvider, useFleetAuth } = await import('@/hooks/useFleetAuth');

let root: Root | null = null;
const flush = () => act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); });
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.innerHTML = ''; vi.unstubAllGlobals(); });

function Shows({ idle }: { idle?: boolean }) {
  const auth = useFleetAuth({ idle });
  return h('span', null, `${auth.status}:${auth.fleetId ?? ''} `);
}

async function mount(node: React.ReactNode) {
  const el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el);
  await act(async () => root!.render(node)); await flush();
  return el;
}

it('five consumers under one provider make one session check', async () => {
  const request = vi.fn().mockResolvedValue(json({ fleetId: 'fleet-a' }, 200));
  vi.stubGlobal('fetch', request);
  const el = await mount(h(FleetAuthProvider, null, ...Array.from({ length: 5 }, (_, i) => h(Shows, { key: i }))));
  expect(request).toHaveBeenCalledTimes(1);
  expect(el.textContent?.trim().split(' ')).toEqual(Array(5).fill('authenticated:fleet-a'));
});

it('outside a provider, each consumer checks on its own, unless idle', async () => {
  const request = vi.fn().mockResolvedValue(json({ fleetId: 'fleet-a' }, 200));
  vi.stubGlobal('fetch', request);
  await mount(h('div', null, h(Shows), h(Shows, { idle: true })));
  expect(request).toHaveBeenCalledTimes(1);
});
