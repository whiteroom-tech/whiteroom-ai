// auditSummary's `tz` decides which days savingsByDay splits on. Billing
// reads UTC days; every page keeps the viewer's zone.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { auditSummary } from '@/lib/whiteroom/client';
import { viewerTimeZone } from '@/lib/runs';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue(new Response(JSON.stringify({ fleetId: 'f1', savingsBuckets: [] }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const sentBody = () => JSON.parse(fetchMock.mock.calls[0][1].body as string);

it('sends the zone it is given', async () => {
  await auditSummary('f1', new Date('2026-10-26T00:00:00Z'), 'wr_test_token', undefined, 'UTC');
  expect(sentBody()).toMatchObject({ action: 'audit_summary', fleet_id: 'f1', from: '2026-10-26T00:00:00.000Z', tz: 'UTC' });
  expect(sentBody().hours_back).toBeUndefined();
});

it("defaults to the viewer's zone", async () => {
  await auditSummary('f1', new Date('2026-10-26T00:00:00Z'), 'wr_test_token', 24);
  expect(sentBody()).toMatchObject({ tz: viewerTimeZone(), hours_back: 24 });
});
