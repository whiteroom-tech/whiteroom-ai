import { describe, it, expect } from 'vitest';
import {
  findingSentence, sentenceText, costLine, notMeasuredText, howtoParagraphs, limitationText, TITLES, DIAGNOSIS_DETECTORS,
} from '@/lib/diagnosis/copy';
import { statusLine, attentionStrip, checkedSummary, shouldRefetchOnFocus, relativeTime, FOCUS_REFETCH_MS } from '@/lib/diagnosis/model';
import type { DiagnosisDetectorId, DiagnosisMeasures, FleetDiagnosis, DiagnosisFinding } from '@/lib/whiteroom/types';

const MEASURES: Record<DiagnosisDetectorId, DiagnosisMeasures> = {
  review_handover_churn: { shortWatches: 20, totalWatches: 25, longestStreak: 20, medianCallsPerWatch: 1.5, limitMultiplier: 4 },
  review_tool_loops: { toolName: 'search_places', maxRepeats: 9, worstWatch: 14, watchesAffected: 3, repeatedCalls: 12, coveragePct: 100 },
  review_spend_outliers: { baselineP90: 940000, flaggedDays: 2, maxDayTokens: 2900000, maxDayRatio: 3.1, maxDay: '2026-09-22' },
  review_tool_errors: { toolName: 'fetch_page', toolErrors: 28, totalErrors: 28, totalResults: 100, errorRatePct: 28 },
  review_tool_silence: { toolName: 'persist_lead', baselineCallsPerDay: 11.4, recentCallsPerDay: 0, dropPct: 100, lastCalled: '2026-09-15', recentCalls: 412, silentTools: 2 },
  review_provider_failures: { totalRequests: 240, upstreamErrors: 31, failureRatePct: 13, model: 'claude-haiku-4-5', otherCohorts: 1 },
};

/** Every number in the text, normalised (thousands separators dropped). */
const numbersIn = (s: string) => (s.match(/\d[\d,]*(\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, ''));
const measureValues = (m: DiagnosisMeasures) => new Set(Object.values(m).flatMap((v) => (typeof v === 'number' ? [String(v)] : numbersIn(v))));

describe('finding sentences', () => {
  for (const d of DIAGNOSIS_DETECTORS) {
    it(`${d}: every number printed is a value in measures`, () => {
      const text = sentenceText(findingSentence(d, MEASURES[d]));
      const allowed = measureValues(MEASURES[d]);
      allowed.add('1.5'); // the spend spike threshold, a fixed rule, not a measurement
      allowed.add('24'); // "the last 24 hours" window in the provider sentence
      for (const n of numbersIn(text)) expect(allowed, `"${n}" in: ${text}`).toContain(n);
      expect(text.length).toBeGreaterThan(20);
    });
  }

  it('churn hedges the cause and mentions the raised limit only when raised', () => {
    const t = sentenceText(findingSentence('review_handover_churn', MEASURES.review_handover_churn));
    expect(t).toContain('This often means');
    expect(t).toContain('4×');
    expect(sentenceText(findingSentence('review_handover_churn', { ...MEASURES.review_handover_churn, limitMultiplier: 1 }))).not.toContain('raised');
  });

  it('tool silence mentions several quiet tools only when there are several', () => {
    expect(sentenceText(findingSentence('review_tool_silence', MEASURES.review_tool_silence))).toContain('2 tools went quiet');
    expect(sentenceText(findingSentence('review_tool_silence', { ...MEASURES.review_tool_silence, silentTools: 1 }))).not.toContain('went quiet at');
  });

  it('titles are plain words, never detector ids', () => {
    for (const d of DIAGNOSIS_DETECTORS) expect(TITLES[d]).not.toMatch(/review_|_/);
  });
});

describe('cost, limitations, reasons, how-to', () => {
  it('cost line shows tokens and money, or tokens alone, or nothing', () => {
    expect(costLine(1_200_000, 1_840_000)).toBe('About 1,200,000 tokens (≈ $1.84) went to this in the last 7 days.');
    expect(costLine(5000, null)).toBe('About 5,000 tokens went to this in the last 7 days.');
    expect(costLine(null, null)).toBeNull();
  });

  it('limitations are reworded without internal terms', () => {
    expect(limitationText('review_tool_errors', 'Counts only results your agent marks is_error.')).toBe('Only counts errors your agent reports back.');
    expect(limitationText('review_tool_errors', 'x')).not.toContain('is_error');
  });

  it('not-measured reasons read as plain sentences', () => {
    expect(notMeasuredText('few_watches', 'Needs 5 watches with watch numbers; has 3')).toBe('Needs a few more watches to judge (3 of 5 so far).');
    expect(notMeasuredText('short_history', 'Needs 14 days of history with full tool capture; has 6')).toBe('Needs 14 days of history (6 so far).');
    expect(notMeasuredText('low_coverage', 'Tool arguments captured for 40% of calls (streaming or older data)')).toBe('Can only see 40% of this agent’s tool calls. Streamed replies hide them.');
    expect(notMeasuredText('hashing_off', 'Tool-call hashing is off on this engine')).toBe('This check is switched off on your WhiteRoom engine.');
    expect(notMeasuredText('first_check_pending', 'First check runs overnight')).toBe('First check runs overnight.');
    expect(notMeasuredText('something_new', 'Engine reason')).toBe('Engine reason.');
  });

  it('how-to text only claims what the evidence shows', () => {
    const all = ['handover_churn', 'tool_errors', 'tool_silence', 'provider_failures'].flatMap((h) => howtoParagraphs(h, { toolName: 'fetch_page' })).join(' ');
    expect(all).not.toMatch(/most text|which pages fail and how|reopens|checks whether the fix holds/i);
    expect(howtoParagraphs('tool_errors', { toolName: 'fetch_page' })[0]).toBe('See which calls reported a fetch_page error. Check your agent’s logs for the cause.');
  });
});

const finding = (detector: DiagnosisDetectorId, status = 'open'): DiagnosisFinding => ({
  recommendationId: `pr_${detector}`, findingId: `pf_${detector}`, findingVersion: 1, detector, detectorVersion: 1, status,
  measures: MEASURES[detector], estWastedTokens: null, estWastedCostMicros: null, evidenceCallIds: ['a', 'b', 'c'], coverage: 'complete',
  limitations: null, suggestedAction: { kind: 'howto', howtoId: 'tool_errors' },
});
const report = (agentId: string, findings: DiagnosisFinding[]) => ({
  schema: 'diagnosis.v1' as const, agentId, window: { from: '', to: '', days: 7 as const, calls: 80, watches: 12 }, findings,
  clear: [{ detector: 'review_tool_loops' as const, note: null }],
  notMeasured: [{ detector: 'review_spend_outliers' as const, code: 'short_history', reason: 'Needs 14 days of history; has 6' }],
});
const NOW = Date.parse('2026-09-29T12:00:00Z');
const fleet = (p: Partial<FleetDiagnosis> = {}): FleetDiagnosis => ({
  checkedAt: '2026-09-29T11:22:00Z', source: 'background', reports: [], waiting: [], skipped: [], truncated: false,
  readyAgents: 3, busiest: { agentId: 'lead-agent', calls7d: 412 }, minCalls: 50, ...p,
});

describe('status line', () => {
  it('each state reads as specified', () => {
    expect(statusLine(null, 'idle', NOW, false)).toBeNull();
    expect(statusLine(fleet({ readyAgents: 0, busiest: { agentId: 'summarizer', calls7d: 41 } }), 'idle', NOW, false))
      .toMatchObject({ text: 'WhiteRoom starts checking an agent once it makes 50 calls in a week. summarizer is at 41 of 50.', action: null });
    expect(statusLine(fleet(), 'idle', NOW, false)).toMatchObject({ text: 'Checked 38 min ago · 3 agents', action: { label: 'Check now' } });
    expect(statusLine(fleet({ checkedAt: null }), 'idle', NOW, false)).toMatchObject({ text: 'First check runs within the hour · 3 agents ready', action: { label: 'Check now' } });
    expect(statusLine(fleet(), 'checking', NOW, false)).toMatchObject({ text: 'Checking 3 agents…', busy: true, action: null });
    expect(statusLine(fleet({ truncated: true, reports: [report('a', []), report('b', [])], skipped: [{ agentId: 'c', calls7d: 60 }] }), 'idle', NOW, false))
      .toMatchObject({ text: 'Checked 2 of 3 agents.', action: { label: 'Check the rest' } });
    expect(statusLine(fleet(), 'error', NOW, false)).toMatchObject({ text: 'Couldn’t finish the check. Your agents aren’t affected.', action: { label: 'Try again' }, error: true });
    expect(statusLine(fleet({ checkedAt: new Date(NOW).toISOString(), reports: [report('a', [finding('review_tool_errors')])] }), 'idle', NOW, true))
      .toMatchObject({ text: 'Checked just now · 3 agents · 1 finding' });
  });
});

describe('attention strip', () => {
  it('hidden when nothing is open, including snoozed findings', () => {
    expect(attentionStrip(null)).toBeNull();
    expect(attentionStrip(fleet({ reports: [report('a', [finding('review_tool_errors', 'snoozed')])] }))).toBeNull();
  });
  it('one agent, or up to three names then "+k more"', () => {
    expect(attentionStrip(fleet({ reports: [report('lead-agent', [finding('review_tool_errors')])] }))).toEqual({ lead: 'lead-agent needs attention', names: '' });
    const five = ['a', 'b', 'c', 'd', 'e'].map((n) => report(n, [finding('review_tool_errors')]));
    expect(attentionStrip(fleet({ reports: five }))).toEqual({ lead: '5 agents need attention:', names: 'a, b, c +2 more' });
  });
});

describe('what we checked', () => {
  it('lists nothing-found agents, looks-fine and needs-more-data per agent, and waiting agents', () => {
    const s = checkedSummary(fleet({
      reports: [report('lead-agent', [finding('review_tool_errors')]), report('triage', [])],
      waiting: [{ agentId: 'summarizer', calls7d: 41 }],
    }));
    expect(s.nothingFound).toEqual(['triage']);
    expect(s.perAgent[0]).toEqual({ agentId: 'lead-agent', looksFine: ['repeating the same call'], needsData: [{ title: 'unusually expensive days', text: 'Needs 14 days of history (6 so far).' }] });
    expect(s.waiting).toEqual([{ agentId: 'summarizer', text: '41 of 50 calls. Checked automatically once it gets there.' }]);
  });
});

describe('refetch on focus', () => {
  it('at most every 5 minutes, and never while hidden', () => {
    expect(shouldRefetchOnFocus(null, NOW, false)).toBe(true);
    expect(shouldRefetchOnFocus(NOW - FOCUS_REFETCH_MS + 1, NOW, false)).toBe(false);
    expect(shouldRefetchOnFocus(NOW - FOCUS_REFETCH_MS, NOW, false)).toBe(true);
    expect(shouldRefetchOnFocus(null, NOW, true)).toBe(false);
  });
  it('relative time', () => {
    expect(relativeTime(new Date(NOW - 20_000).toISOString(), NOW)).toBe('just now');
    expect(relativeTime(new Date(NOW - 3 * 3600_000).toISOString(), NOW)).toBe('3 hours ago');
  });
});

import { evidenceHeader } from '@/lib/diagnosis/model';

describe('evidence headers', () => {
  const c = (p: Record<string, unknown>) => ({ requestEnd: '2026-09-28T14:02:00Z', ...p });
  it('churn: calls per watch', () => {
    const h = evidenceHeader('review_handover_churn', [c({ watchNumber: 31 }), c({ watchNumber: 32 }), c({ watchNumber: 32 })], {});
    expect(h).toMatchObject({ kind: 'watches', watches: [{ watch: 31, calls: 1 }, { watch: 32, calls: 2 }] });
  });
  it('loops: grouped by watch and short hash, never argument values', () => {
    const calls = Array.from({ length: 9 }, () => c({ watchNumber: 14, toolCallHashes: [{ n: 'search_places', h: 'a91f03c2' }] }));
    const h = evidenceHeader('review_tool_loops', calls, { toolName: 'search_places' });
    expect(h).toMatchObject({ kind: 'table', rows: [['search_places', 'same · a91f03c2', '9', '14']] });
  });
  it('silence: offered vs called', () => {
    const h = evidenceHeader('review_tool_silence', [c({ watchNumber: 50, toolNames: ['search', 'persist_lead'], requestedToolNames: ['search'] })], { toolName: 'persist_lead' });
    expect(h && h.kind === 'table' && h.rows[0].slice(1)).toEqual(['50', 'yes', 'search']);
  });
  it('errors: counts and tool names only', () => {
    const h = evidenceHeader('review_tool_errors', [c({ watchNumber: 44, toolResults: 2, toolErrorNames: ['fetch_page', 'fetch_page'] })], { toolName: 'fetch_page' });
    expect(h && h.kind === 'table' && h.rows[0].slice(1)).toEqual(['44', '2', 'fetch_page, fetch_page']);
  });
  it('other detectors keep the existing view', () => {
    expect(evidenceHeader('review_tool_bloat', [], {})).toBeNull();
  });
});
