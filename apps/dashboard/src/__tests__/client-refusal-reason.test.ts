// A 403 the engine explains carries its reason, so a caller can tell its
// cases apart (the full export's dashboard-only refusal); a control refusal
// stays its own error, and an unexplained or overlong body carries none.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ControlDeniedError, exportAuditFullPage, WhiteRoomApiError } from '@/lib/whiteroom/client';

const fetchMock = vi.fn();
const reply = (body: unknown, status: number) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

const refusal = async () => exportAuditFullPage('f1', undefined, 'key').catch((e: unknown) => e);

it('passes on the engine’s reason for a 403', async () => {
  fetchMock.mockResolvedValueOnce(reply({ error: 'This action is only available from the WhiteRoom dashboard.' }, 403));
  const e = await refusal();
  expect(e).toBeInstanceOf(WhiteRoomApiError);
  expect(e).not.toBeInstanceOf(ControlDeniedError);
  expect((e as WhiteRoomApiError).status).toBe(403);
  expect((e as WhiteRoomApiError).reason).toBe('This action is only available from the WhiteRoom dashboard.');
});

it('carries no reason for a body without one, a non-string one, or an overlong one', async () => {
  fetchMock.mockResolvedValueOnce(reply('not json', 403));
  expect(((await refusal()) as WhiteRoomApiError).reason).toBeUndefined();
  fetchMock.mockResolvedValueOnce(reply({ error: { nested: true } }, 403));
  expect(((await refusal()) as WhiteRoomApiError).reason).toBeUndefined();
  fetchMock.mockResolvedValueOnce(reply({ error: 'x'.repeat(301) }, 403));
  expect(((await refusal()) as WhiteRoomApiError).reason).toBeUndefined();
});
