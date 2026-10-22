// Performance › Agent health: how the card's three sources become what it shows.
import { describe, expect, it } from 'vitest';
import { agentHealthView, type FlagState } from '@/lib/agent-health';
import type { DiagnosisFinding, FleetDiagnosis } from '@/lib/whiteroom/types';

const quietFlags: FlagState = { count: 0, truncated: false, failed: false, loading: false };
const finding = (status = 'open'): DiagnosisFinding => ({
  recommendationId: 'pr_1', findingId: 'pf_1', findingVersion: 1, detector: 'review_handover_churn', detectorVersion: 1, status,
  measures: {}, estWastedTokens: null, estWastedCostMicros: null, evidenceCallIds: [], coverage: 'complete', limitations: null, suggestedAction: null,
} as unknown as DiagnosisFinding);
const report = (agentId: string, findings: DiagnosisFinding[]) => ({
  schema: 'diagnosis.v1' as const, agentId, window: { from: '', to: '', days: 7 as const, calls: 80, watches: 12 }, findings,
  clear: [{ detector: 'review_tool_loops' as const, note: null }], notMeasured: [],
});
const fleet = (reports: FleetDiagnosis['reports'], checkedAt: string | null = '2026-10-22T10:00:00Z'): FleetDiagnosis => ({
  checkedAt, source: 'background', reports, waiting: [], skipped: [], truncated: false, readyAgents: reports.length, busiest: null, minCalls: 50,
});
const line = { text: 'Checked 2 hours ago · 1 agent', action: { label: 'Check now' }, busy: false, error: false };

describe('agent health card', () => {
  it('is hidden when there are no run flags and no health check', () => {
    expect(agentHealthView({ ...quietFlags, count: null }, null, null)).toBeNull();
  });

  it('a quiet week: fine, both rows one line, nothing folded open', () => {
    const v = agentHealthView(quietFlags, fleet([report('lead-agent', [])]), line)!;
    expect(v.verdict).toEqual({ tone: 'ok', title: 'Your agents look fine' });
    expect(v.unusual).toEqual({ tone: 'ok', text: 'Nothing unusual this week' });
    expect(v.unusualHasDetail).toBe(false);
    expect(v.health).toEqual({ tone: 'ok', text: '1 check passed' });
    expect(v.healthOpen).toBe(false);
  });

  it('one agent with a problem: named in the verdict, health row open', () => {
    const v = agentHealthView(quietFlags, fleet([report('lead-agent', [finding()]), report('scout', [])]), line)!;
    expect(v.verdict).toEqual({ tone: 'warn', title: 'lead-agent needs a look' });
    expect(v.health!.tone).toBe('warn');
    expect(v.healthOpen).toBe(true);
  });

  it('flagged runs: Unusual behaviour folds out, open, with a capped count marked', () => {
    const v = agentHealthView({ ...quietFlags, count: 1000, truncated: true }, null, null)!;
    expect(v.unusual).toEqual({ tone: 'warn', text: '1,000+ runs flagged this week' });
    expect(v.unusualHasDetail).toBe(true);
    expect(v.health).toBeNull();
    expect(v.verdict!.title).toBe('1,000+ runs looked unusual');
  });

  it('never "fine" while flags load or after they fail', () => {
    expect(agentHealthView({ ...quietFlags, count: null, loading: true }, fleet([report('a', [])]), line)!.verdict).toBeNull();
    expect(agentHealthView({ ...quietFlags, count: null, failed: true }, fleet([report('a', [])]), line)!.verdict).toBeNull();
  });

  it('before the first stored check: a short row, the status line stays for the header', () => {
    const v = agentHealthView(quietFlags, fleet([], null), { ...line, text: 'First check runs within the hour' })!;
    expect(v.health).toEqual({ tone: 'muted', text: 'Not checked yet' });
    const failed = agentHealthView(quietFlags, null, { text: 'Couldn’t finish the check.', action: { label: 'Try again' }, busy: false, error: true })!;
    expect(failed.health).toEqual({ tone: 'warn', text: 'The last check didn’t finish' });
  });
});
