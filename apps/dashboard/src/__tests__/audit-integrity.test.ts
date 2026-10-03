// Audit integrity on the dashboard (Phase 1 spec H2, H6): wording for the
// new event types, and requests retried through an engine handoff.

import { it, expect, vi, afterEach, describe } from 'vitest';
import { eventModel } from '@/lib/activity';
import { activityRow } from '@/lib/home';
import { auditIntegrity } from '@/lib/whiteroom/client';
import type { AuditEntry } from '@/lib/whiteroom/types';

const ev = (e: Record<string, unknown>) =>
  ({ id: 'e1', timestamp: '2026-10-03T19:44:00.000Z', ...e }) as AuditEntry;

describe('integrity events read in plain words, with WhiteRoom as the subject', () => {
  it('an unexpected restart names its window', () => {
    const e = ev({ type: 'unclean_stop', from: '2026-10-03T19:41:00.000Z', to: '2026-10-03T19:44:00.000Z' });
    const m = eventModel(e, Date.parse('2026-10-03T19:50:00.000Z'));
    expect(m.who).toBe('WhiteRoom');
    expect(m.said).toMatch(/^restarted unexpectedly; events between \d{1,2}:41 [ap]m and \d{1,2}:44 [ap]m may be missing$/);
    expect(activityRow(e).text.startsWith('WhiteRoom restarted unexpectedly')).toBe(true);
    expect(activityRow(e).tag).toEqual({ label: 'Gap', tone: 'warn' });
  });

  it('reads without a window, and the other new types have their own words', () => {
    expect(eventModel(ev({ type: 'possible_gap' })).said).toContain('around then');
    expect(eventModel(ev({ type: 'fleet_created' })).said).toBe('started tracking history');
    expect(eventModel(ev({ type: 'fleet_reset' })).said).toBe("reset the fleet's counters; history is kept");
    expect(eventModel(ev({ type: 'observations_batch', agentId: 'lead-agent', count: 40 })).said).toBe('finished 40 calls (grouped during a slowdown)');
  });
});

describe('a request that meets an engine handoff', () => {
  afterEach(() => vi.unstubAllGlobals());
  const handoff = () => new Response(JSON.stringify({ whiteroom: { reason: 'whiteroom_handoff', forwarded: false } }), { status: 503, headers: { 'Retry-After': '0' } });

  it('is retried and succeeds without an error', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(handoff())
      .mockResolvedValueOnce(new Response(JSON.stringify({ fleetId: 'f1', mode: 'sequenced' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(auditIntegrity('f1', 'key')).resolves.toMatchObject({ mode: 'sequenced' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after two retries, and never retries any other 503', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => handoff());
    vi.stubGlobal('fetch', fetchMock);
    await expect(auditIntegrity('f1', 'key')).rejects.toThrow('HTTP 503');
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const other = vi.fn().mockResolvedValue(new Response('{}', { status: 503 }));
    vi.stubGlobal('fetch', other);
    await expect(auditIntegrity('f1', 'key')).rejects.toThrow('HTTP 503');
    expect(other).toHaveBeenCalledTimes(1);
  });
});
