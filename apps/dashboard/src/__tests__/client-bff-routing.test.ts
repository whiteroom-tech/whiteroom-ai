// postRaw's route selection after the cookie migration: keyless browser
// calls go through the /api/fleet/engine BFF (no credential in the page),
// while explicit-key calls, token_login, and server-side calls stay direct.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fleetReport,
  isAuthError,
  listFleets,
  tokenLogin,
  PROXY_URL,
} from '@/lib/whiteroom/client';

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function enterBrowser() {
  (globalThis as { window?: unknown }).window = {};
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(jsonResponse({ success: true, fleetId: 'f1' }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { window?: unknown }).window;
});

it('routes keyless browser calls through the BFF with cookies, no auth header', async () => {
  enterBrowser();
  await fleetReport('fleet-1');

  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe('/api/fleet/engine');
  expect(init.credentials).toBe('same-origin');
  const headers = init.headers as Record<string, string>;
  expect(headers.Authorization).toBeUndefined();
  expect(headers['x-api-key']).toBeUndefined();
});

it('keeps explicit-key browser calls direct to the engine', async () => {
  enterBrowser();
  fetchMock.mockResolvedValue(jsonResponse({ fleets: [] }));
  await listFleets('sk-test-key');

  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe(`${PROXY_URL}/api/white-room`);
  expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-test-key');
});

it('keeps token_login direct even though it is keyless (login has no cookie yet)', async () => {
  enterBrowser();
  await tokenLogin('ft-fresh');

  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe(`${PROXY_URL}/api/white-room`);
  expect(JSON.parse(init.body as string)).toMatchObject({
    action: 'token_login',
    fleet_token: 'ft-fresh',
  });
});

it('keeps server-side keyless calls direct (no window)', async () => {
  await fleetReport('fleet-1');
  expect(fetchMock.mock.calls[0][0]).toBe(`${PROXY_URL}/api/white-room`);
});

it('surfaces a BFF 401 as a WhiteRoomApiError auth error', async () => {
  enterBrowser();
  fetchMock.mockResolvedValue(jsonResponse({ error: 'No fleet session.' }, 401));

  const err = await fleetReport('fleet-1').catch((e) => e);
  expect(isAuthError(err)).toBe(true);
});
