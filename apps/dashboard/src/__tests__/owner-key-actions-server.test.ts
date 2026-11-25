// @vitest-environment node
// Outside the browser there is no BFF to go through: every key action,
// the owner's too, goes straight to the engine with the fleet's key.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gatewayKeyAdd, storeProviderKey } from '@/lib/whiteroom/client';

const auth = { fleetId: 'f', apiKey: 'sk-wr-placeholder', fleetToken: 'wr_placeholder' };
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('owner key actions outside the browser', () => {
  it('go straight to the engine with the fleet key', async () => {
    expect(typeof window).toBe('undefined');
    await storeProviderKey(auth, 'sk-ant-placeholder', undefined, undefined, 'billing');
    await gatewayKeyAdd(auth, 'placeholder');
    for (const [url, init] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
      expect(String(url)).not.toBe('/api/fleet/engine');
      const h = new Headers(init.headers);
      expect(h.has('authorization') || h.has('x-api-key')).toBe(true);
    }
  });
});
