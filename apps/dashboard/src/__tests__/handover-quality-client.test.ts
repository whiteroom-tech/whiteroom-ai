// Agent detail › Handover quality reads its figures through this call.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handoverQuality } from '@/lib/whiteroom/client';

const fetchMock = vi.fn();
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('handover quality client', () => {
  it('asks for an agent and a number of days', async () => {
    const q = { handovers: 1, scored: 1, valuesChecked: 2, valuesKept: 2, valuesKeptShare: 1, shareChecked: 1, coverageMin: 0.9, keptWithLabel: null, goalCarriedOver: null };
    fetchMock.mockResolvedValue(jsonResponse(q));
    await expect(handoverQuality('f', 'a', 14)).resolves.toEqual(q);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ action: 'handover_quality', fleet_id: 'f', agent_id: 'a', days: 14 });
  });

  it('returns null from an engine without the action, so the panel hides', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Unknown action: handover_quality' }, 400));
    await expect(handoverQuality('f', 'a')).resolves.toBeNull();
  });
});
