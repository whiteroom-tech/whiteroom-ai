// Performance › Agent health: how its two sources become the problems-by-agent table.
import { describe, expect, it } from 'vitest';
import { HEALTH_ROW_CAP, healthByAgent } from '@/lib/agent-health';
import { flagFetch } from '@/components/performance/UnusualBehaviour';
import { diagnosisFailure } from '@/lib/diagnosis/useDiagnosis';
import { WhiteRoomApiError } from '@/lib/whiteroom/client';
import type { DiagnosisFinding, FleetDiagnosis } from '@/lib/whiteroom/types';

const days = ['2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22'];
const finding = (detector = 'review_handover_churn', recommendationId = 'pr_1', status = 'open'): DiagnosisFinding => ({
  recommendationId, findingId: 'pf_1', findingVersion: 1, detector, detectorVersion: 1, status,
  measures: {}, estWastedTokens: null, estWastedCostMicros: null, evidenceCallIds: [], coverage: 'complete', limitations: null, suggestedAction: null,
} as unknown as DiagnosisFinding);
const report = (agentId: string, findings: DiagnosisFinding[], o: Partial<FleetDiagnosis['reports'][number]> = {}): FleetDiagnosis['reports'][number] => ({
  schema: 'diagnosis.v1' as const, agentId, window: { from: '', to: '', days: 7 as const, calls: 80, watches: 12 }, findings,
  clear: [{ detector: 'review_tool_loops' as const, note: null }], notMeasured: [], ...o,
});
const fleet = (reports: FleetDiagnosis['reports'], o: Partial<FleetDiagnosis> = {}): FleetDiagnosis => ({
  checkedAt: '2026-10-22T10:00:00Z', source: 'background', reports, waiting: [], skipped: [], truncated: false, readyAgents: reports.length, busiest: null, minCalls: 50, ...o,
});
const run = (agentId: string, day: string, signal = 'repeating_call') => ({ agentId, startedAt: `${day}T12:00:00`, flags: [{ signal }] }) as never;
const flags = (runs: never[] | null, truncated = false) => ({ runs, truncated, days });
const NO_FLAGS = flags([]);

describe('problems by agent', () => {
  it('lists only agents with an open problem or a flagged run, and claims nothing about the rest', () => {
    const t = healthByAgent(fleet([report('lead-agent', [finding()]), report('quiet', [])]), 'ready', flags([run('scout', '2026-10-21')]));
    expect(t.rows.map((r) => r.agentId)).toEqual(['lead-agent', 'scout']);
    expect(t.showProblems).toBe(true);
    expect(t.showFlags).toBe(true);
  });

  it('gives each open finding a tag that carries its own recommendation; one that is not open is no tag', () => {
    const t = healthByAgent(fleet([report('lead-agent', [finding('review_handover_churn', 'pr_a'), finding('review_tool_errors', 'pr_b'), finding('review_tool_loops', 'pr_c', 'snoozed')])]), 'ready', NO_FLAGS);
    expect(t.rows[0].tags).toEqual([{ title: 'Starting over too often', recommendationId: 'pr_a' }, { title: 'A tool keeps failing', recommendationId: 'pr_b' }]);
    expect(t.rows[0].checkState).toBeNull();
    // Only a snoozed finding: no open problem, so no row at all.
    expect(healthByAgent(fleet([report('lead-agent', [finding('review_tool_loops', 'pr_c', 'snoozed')])]), 'ready', NO_FLAGS).rows).toEqual([]);
  });

  it('orders by most problems, then most flagged runs, then name', () => {
    const d = fleet([report('b-one', [finding()]), report('a-two', [finding('review_handover_churn', 'pr_x'), finding('review_tool_errors', 'pr_y')]), report('c-one', [finding()])]);
    const t = healthByAgent(d, 'ready', flags([run('c-one', '2026-10-21'), run('z-flag', '2026-10-20'), run('z-flag', '2026-10-21'), run('y-flag', '2026-10-21')]));
    expect(t.rows.map((r) => r.agentId)).toEqual(['a-two', 'c-one', 'b-one', 'z-flag', 'y-flag']);
  });

  it('says where a flag-only agent’s checks really stand, never a blanket pass', () => {
    const notMeasured = [{ detector: 'review_spend_outliers' as const, code: 'short_history', reason: 'x' }, { detector: 'review_tool_silence' as const, code: 'short_history', reason: 'x' }];
    const d = fleet([
      report('all-passed', []),
      report('mixed', [], { notMeasured }),
      report('one-short', [], { notMeasured: [notMeasured[0]] }),
      report('no-data', [], { clear: [], notMeasured }),
      report('set-aside', [finding('review_tool_loops', 'pr_c', 'dismissed')], { clear: [] }),
    ], { waiting: [{ agentId: 'short', calls7d: 12 }], skipped: [{ agentId: 'skipped', calls7d: 90 }], minCalls: 40 });
    const ids = ['all-passed', 'mixed', 'one-short', 'no-data', 'set-aside', 'short', 'skipped', 'stranger'];
    const t = healthByAgent(d, 'ready', flags(ids.map((id) => run(id, '2026-10-21'))));
    const state = Object.fromEntries(t.rows.map((r) => [r.agentId, r.checkState]));
    expect(state).toEqual({
      'all-passed': '1 passed',
      mixed: '1 passed · 2 need more data',
      'one-short': '1 passed · 1 needs more data',
      'no-data': 'Needs more data',
      'set-aside': 'No open problems',
      // The threshold is the check's own, not a fixed number.
      short: 'Not checked yet (40 calls a week needed)',
      skipped: 'Not checked',
      stranger: 'Not checked',
    });
  });

  it('counts each agent’s flagged runs per day on one scale, and names what they were flagged for', () => {
    const t = healthByAgent(null, 'unavailable', flags([run('a', '2026-10-20'), run('a', '2026-10-20'), run('a', '2026-10-22', 'error_streak'), run('b', '2026-10-21'), run('a', '2026-09-01')]));
    expect(t.showProblems).toBe(false);
    const a = t.rows.find((r) => r.agentId === 'a')!;
    expect(a.perDay).toEqual([0, 0, 0, 0, 2, 0, 1]);
    expect(a.total).toBe(3);
    expect(a.runsLabel).toBe('3 runs');
    expect(a.flaggedFor).toBe('repeating the same call, failed calls in a row');
    expect(a.checkState).toBeNull();
    expect(t.rows.find((r) => r.agentId === 'b')!.runsLabel).toBe('1 run');
    expect(t.max).toBe(2);
  });

  it('a problem agent with no flagged runs shows zero, not nothing', () => {
    const r = healthByAgent(fleet([report('lead-agent', [finding()])]), 'ready', NO_FLAGS).rows[0];
    expect(r.perDay).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(r.total).toBe(0);
    expect(r.flaggedFor).toBeNull();
  });

  it('only the newest flagged runs read: counts are lower bounds, and an agent not among them is unknown, not zero', () => {
    const t = healthByAgent(fleet([report('lead-agent', [finding()]), report('scout', [finding()])]), 'ready', flags([run('scout', '2026-10-21')], true));
    expect(t.atLeast).toBe(true);
    const scout = t.rows.find((r) => r.agentId === 'scout')!;
    expect(scout.runsLabel).toBe('1+ runs');
    const lead = t.rows.find((r) => r.agentId === 'lead-agent')!;
    expect(lead.perDay).toBeNull();
    expect(lead.total).toBeNull();
    expect(lead.runsLabel).toBeNull();
  });

  it('an engine without run flags: no flag columns, problems still listed', () => {
    const t = healthByAgent(fleet([report('lead-agent', [finding()])]), 'ready', flags(null));
    expect(t.showFlags).toBe(false);
    expect(t.atLeast).toBe(false);
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0].perDay).toBeNull();
  });

  it('a failed, off or pending health read shows no problems and no check state: it never reads as passed', () => {
    for (const state of ['failed', 'unavailable', 'pending'] as const) {
      // Even with a stale result in hand, a read that isn't ready says nothing about checks.
      const t = healthByAgent(fleet([report('lead-agent', [finding()])]), state, flags([run('scout', '2026-10-21')]));
      expect(t.showProblems).toBe(false);
      expect(t.rows.map((r) => r.agentId)).toEqual(['scout']);
      expect(t.rows[0].checkState).toBeNull();
      expect(t.rows[0].tags).toEqual([]);
    }
  });

  it('the check on with nothing stored yet: flagged agents say they are not checked yet', () => {
    const t = healthByAgent(fleet([], { checkedAt: null, waiting: [{ agentId: 'lead-agent', calls7d: 31 }] }), 'ready', flags([run('lead-agent', '2026-10-21'), run('scout', '2026-10-21')]));
    expect(t.rows.map((r) => [r.agentId, r.checkState])).toEqual([['lead-agent', 'Not checked yet (50 calls a week needed)'], ['scout', 'Not checked']]);
  });

  it('a large fleet: every agent with a problem is a row; the card shows the first ten', () => {
    const t = healthByAgent(fleet(Array.from({ length: 25 }, (_, i) => report(`agent-${String(i).padStart(2, '0')}`, [finding('review_tool_errors', `pr_${i}`)]))), 'ready', NO_FLAGS);
    expect(t.rows).toHaveLength(25);
    expect(HEALTH_ROW_CAP).toBe(10);
  });
});

describe('a failed health read', () => {
  it('is "unavailable" when the engine answers that the check is not there, "failed" when nothing is known', () => {
    expect(diagnosisFailure(new WhiteRoomApiError('HTTP 404', 404))).toBe('unavailable'); // switched off
    expect(diagnosisFailure(new WhiteRoomApiError('HTTP 400', 400, 'Diagnosis runs on production fleets.'))).toBe('unavailable'); // a sandbox fleet
    expect(diagnosisFailure(new WhiteRoomApiError('HTTP 400', 400, 'Unknown action.'))).toBe('unavailable'); // an engine older than the check
    // Any other refusal is a real error: said on the page, never hidden as "off".
    expect(diagnosisFailure(new WhiteRoomApiError('HTTP 400', 400, 'fleet_id is required.'))).toBe('failed');
    expect(diagnosisFailure(new WhiteRoomApiError('HTTP 400', 400))).toBe('failed');
    expect(diagnosisFailure(new WhiteRoomApiError('HTTP 503', 503))).toBe('failed');
    expect(diagnosisFailure(new WhiteRoomApiError('HTTP 401', 401))).toBe('failed');
    expect(diagnosisFailure(new WhiteRoomApiError('network'))).toBe('failed');
    expect(diagnosisFailure(new Error('boom'))).toBe('failed');
  });
});

describe('flagged-runs fetch', () => {
  const runs = [{ agentId: 'a', startedAt: '2026-10-22T10:00:00Z', flags: [{ signal: 'repeating_call' }] }] as never[];
  const loading = flagFetch(undefined as never, { type: 'start' });
  it('starts loading and clears the old result', () => {
    expect(loading).toEqual({ runs: null, truncated: false, failed: false, loading: true });
  });
  it('always stops loading: with runs, on an engine without flags, or on failure', () => {
    expect(flagFetch(loading, { type: 'done', got: { runs, truncated: true } })).toEqual({ runs, truncated: true, failed: false, loading: false });
    expect(flagFetch(loading, { type: 'done', got: { unsupported: true } })).toEqual({ runs: null, truncated: false, failed: false, loading: false });
    expect(flagFetch(loading, { type: 'failed' })).toEqual({ runs: null, truncated: false, failed: true, loading: false });
  });
  it('an older engine that ignores the flagged filter (no run has flags): treated as no flags, not as flagged runs', () => {
    const unflagged = [{ agentId: 'a', startedAt: '2026-10-22T10:00:00Z' }, { agentId: 'b', startedAt: '2026-10-22T11:00:00Z' }] as never[];
    expect(flagFetch(loading, { type: 'done', got: { runs: unflagged, truncated: false } })).toEqual({ runs: null, truncated: false, failed: false, loading: false });
  });
  it('a refetch after a failure clears the failure', () => {
    expect(flagFetch(flagFetch(loading, { type: 'failed' }), { type: 'start' }).failed).toBe(false);
  });
});
