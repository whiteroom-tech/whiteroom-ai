// What Performance's range reads send: one window as from (and to, when it
// ends before now), never mixed with hours_back where the engine would read
// that instead; hours_back alone for older callers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditSummary, performanceFleetHourly, performanceIndex } from '@/lib/whiteroom/client';

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset().mockImplementation(async () => new Response(JSON.stringify({ fleetId: 'f1' }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

const sent = () => JSON.parse(fetchMock.mock.lastCall![1].body as string);
const FROM = new Date('2026-10-01T04:00:00Z');
const TO = new Date('2026-10-11T04:00:00Z');

describe('Performance window request bodies', () => {
  it('performance_index: from and to, or from alone to now, or hours_back as before', async () => {
    await performanceIndex('f1', undefined, 'wr_test_token', { from: FROM, to: TO });
    expect(sent()).toMatchObject({ action: 'performance_index', from: '2026-10-01T04:00:00.000Z', to: '2026-10-11T04:00:00.000Z' });
    expect(sent()).not.toHaveProperty('hours_back');
    await performanceIndex('f1', undefined, 'wr_test_token', { from: FROM, to: null });
    expect(sent()).toMatchObject({ from: '2026-10-01T04:00:00.000Z' });
    expect(sent()).not.toHaveProperty('to');
    await performanceIndex('f1', 72, 'wr_test_token');
    expect(sent()).toMatchObject({ hours_back: 72 });
    expect(sent()).not.toHaveProperty('from');
  });

  it('performance_fleet_hourly: the window, plus hours_back only when given (for engines that read only that)', async () => {
    await performanceFleetHourly('f1', 13, 'wr_test_token', { from: FROM, to: null });
    expect(sent()).toMatchObject({ action: 'performance_fleet_hourly', from: '2026-10-01T04:00:00.000Z', hours_back: 13 });
    await performanceFleetHourly('f1', undefined, 'wr_test_token', { from: FROM, to: TO });
    expect(sent()).toMatchObject({ from: '2026-10-01T04:00:00.000Z', to: '2026-10-11T04:00:00.000Z' });
    expect(sent()).not.toHaveProperty('hours_back');
    await performanceFleetHourly('f1', 48, 'wr_test_token');
    expect(sent()).toMatchObject({ hours_back: 48 });
    expect(sent()).not.toHaveProperty('from');
  });

  it('audit_summary: to with from, never with hours_back', async () => {
    await auditSummary('f1', FROM, 'wr_test_token', undefined, undefined, TO);
    expect(sent()).toMatchObject({ action: 'audit_summary', from: '2026-10-01T04:00:00.000Z', to: '2026-10-11T04:00:00.000Z' });
    expect(sent()).not.toHaveProperty('hours_back');
    await auditSummary('f1', FROM, 'wr_test_token', 24, undefined, TO);
    expect(sent()).toMatchObject({ hours_back: 24 });
    expect(sent()).not.toHaveProperty('to');
    await auditSummary('f1', FROM, 'wr_test_token', undefined, undefined, null);
    expect(sent()).not.toHaveProperty('to');
  });
});
