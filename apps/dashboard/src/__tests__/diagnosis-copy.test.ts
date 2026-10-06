import { describe, it, expect } from 'vitest';
import {
  findingSentence, sentenceText, costLine, notMeasuredShort, howtoParagraphs, limitationText, TITLES, DIAGNOSIS_DETECTORS,
} from '@/lib/diagnosis/copy';
import { statusLine, attentionStrip, checkedSummary, shouldRefetchOnFocus, relativeTime, FOCUS_REFETCH_MS, createRequestGate, evidenceHeader, diagnosisSummary } from '@/lib/diagnosis/model';
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

  it('churn from repeated work says so, printing only measured values', () => {
    const m = { ...MEASURES.review_handover_churn, shortWatches: 0, longestStreak: 0, medianCallsPerWatch: 7, repeatWatches: 3, longestRepeatStreak: 2, repeatedSharePct: 81, limitMultiplier: 1.5 };
    const t = sentenceText(findingSentence('review_handover_churn', m));
    expect(t).toContain('Redid 81% of its earlier tool calls, 2 shifts in a row.');
    expect(t).toContain('1.5×');
    for (const n of numbersIn(t)) expect(measureValues(m)).toContain(n);
    // A short-shift streak still leads when both fired.
    expect(sentenceText(findingSentence('review_handover_churn', { ...m, longestStreak: 3 }))).toContain('Handed over after');
  });

  it('churn thresholds: repeat leads from 2 in a row, short shifts from 3', () => {
    const lead = (x: Record<string, number>) => sentenceText(findingSentence('review_handover_churn', { ...MEASURES.review_handover_churn, ...x }));
    expect(lead({ longestRepeatStreak: 1, repeatedSharePct: 60, longestStreak: 0 })).toContain('Handed over after');
    expect(lead({ longestRepeatStreak: 2, repeatedSharePct: 60, longestStreak: 2 })).toContain('Redid 60%');
    expect(lead({ longestRepeatStreak: 2, repeatedSharePct: 60, longestStreak: 3 })).toContain('Handed over after');
  });

  it('older churn findings without repeat measures read as before', () => {
    expect(MEASURES.review_handover_churn).not.toHaveProperty('longestRepeatStreak');
    expect(sentenceText(findingSentence('review_handover_churn', MEASURES.review_handover_churn))).toMatch(/^Handed over after 1\.5 calls on average, 20 shifts in a row\./);
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

  it('not-measured reasons read as short clauses, using the engine\'s numbers', () => {
    // The engine's exact wording (diagnosis/detectors.ts and run.ts).
    const cases: Array<[string, string, string]> = [
      ['few_watches', 'Needs 5 watches with watch numbers; has 3', '3 of 5 shifts so far'],
      ['short_history', 'Needs 14 days of history; has 6', '6 of 14 days of history older than a week'],
      ['low_coverage', 'Tool arguments captured for 40% of calls (streaming or older data)', 'can only see 40% of its tool calls'],
      ['few_results', 'Needs 20 tool results; has 7', '7 of 20 tool results so far'],
      ['few_measured_calls', 'Needs 50 non-streamed calls this week; has 12', '12 of 50 fully recorded calls this week'],
      ['few_requests', 'Needs 100 calls to one model in 24 hours; the busiest had 11', 'busiest model had 11 of the 100 calls needed in 24 hours'],
      ['hashing_off', 'Tool-call hashing is off on this engine', 'switched off on this engine'],
      ['detector_off', 'Provider checks are switched off on this engine', 'switched off on this engine'],
      ['openai_format', 'Tool errors are only counted for Anthropic-format tool results', 'only works with Anthropic-format tools'],
      ['not_captured', "Tool results aren't recorded for these calls yet", 'nothing recorded yet'],
      ['thin_evidence', 'x', 'too few calls show it yet'],
      ['first_check_pending', 'First check runs overnight', 'first check runs overnight'],
      ['publish_failed', "The finding couldn't be saved; it will be retried on the next check", 'couldn\u2019t be saved; checked again soon'],
    ];
    for (const [code, reason, want] of cases) expect(notMeasuredShort(code, reason), code).toBe(want);
  });

  it("if the engine's wording changes, its own text is shown, never a made-up 0", () => {
    expect(notMeasuredShort('few_watches', 'Needs more watches.')).toBe('needs more watches');
    expect(notMeasuredShort('few_requests', 'Traffic too low')).toBe('traffic too low');
    expect(notMeasuredShort('something_new', 'A new reason.')).toBe('a new reason');
  });

  it('counts of one read in the singular', () => {
    const text = (d: DiagnosisDetectorId, m: DiagnosisMeasures) => sentenceText(findingSentence(d, m));
    expect(text('review_tool_loops', { toolName: 'search', maxRepeats: 1, worstWatch: 2, watchesAffected: 1 }))
      .toBe('search repeated 1 time in shift 2, and in 1 shift this week.');
    expect(text('review_spend_outliers', { ...MEASURES.review_spend_outliers, flaggedDays: 1 })).toContain('1 day this week was over 1.5×.');
    expect(text('review_tool_errors', { ...MEASURES.review_tool_errors, toolErrors: 1 })).toContain('failed 1 time this week');
    expect(text('review_handover_churn', { ...MEASURES.review_handover_churn, medianCallsPerWatch: 1, longestStreak: 1 })).toContain('after 1 call on average, 1 shift in a row');
    expect(text('review_tool_silence', { ...MEASURES.review_tool_silence, recentCalls: 1 })).toContain('(1 call)');
    expect(text('review_provider_failures', { ...MEASURES.review_provider_failures, otherCohorts: 1 })).toContain('1 other model is also failing.');
    expect(text('review_provider_failures', { ...MEASURES.review_provider_failures, otherCohorts: 2 })).toContain('2 other models are also failing.');
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

describe('diagnosis card summary', () => {
  const withChecks = (findings: DiagnosisFinding[]) => {
    const r = report('lead-agent', findings);
    return fleet({ reports: [{ ...r, clear: [{ detector: 'review_tool_loops', note: null }, { detector: 'review_tool_errors', note: null }, { detector: 'review_handover_churn', note: null }] }] });
  };
  it('is empty until a check has run', () => {
    expect(diagnosisSummary(null)).toBeNull();
    expect(diagnosisSummary(fleet({ checkedAt: null, reports: [] }))).toBeNull();
  });
  it('says all is well, with what was checked and what still needs data', () => {
    const s = diagnosisSummary(withChecks([]))!;
    expect(s.tone).toBe('ok');
    expect(s.text).toBe(`No problems found · 3 checks look fine · ${s.needsData} ${s.needsData === 1 ? 'needs' : 'need'} more data`);
  });
  it('leads with who needs attention when a finding is open', () => {
    const s = diagnosisSummary(withChecks([finding('review_tool_errors')]))!;
    expect(s).toMatchObject({ tone: 'warn', openFindings: 1 });
    expect(s.text).toBe('lead-agent needs attention · 1 open finding');
  });
  it('a snoozed finding is not an open one', () => {
    expect(diagnosisSummary(withChecks([finding('review_tool_errors', 'snoozed')]))!.tone).toBe('ok');
  });
});

describe('what we checked', () => {
  it('lists nothing-found agents, looks-fine and needs-more-data per agent, and waiting agents', () => {
    const s = checkedSummary(fleet({
      reports: [report('lead-agent', [finding('review_tool_errors')]), report('triage', [])],
      waiting: [{ agentId: 'summarizer', calls7d: 41 }],
    }));
    expect(s.nothingFound).toEqual(['triage']);
    expect(s.perAgent[0]).toEqual({ agentId: 'lead-agent', looksFine: ['repeating the same call'], needsData: [{ title: 'unusually expensive days', text: '6 of 14 days of history older than a week' }] });
    expect(s.waiting).toEqual([{ agentId: 'summarizer', text: '41 of 50 calls. Checked automatically once it gets there.' }]);
  });
  it("an agent whose findings are only snoozed or dismissed isn't 'nothing found'", () => {
    const s = checkedSummary(fleet({ reports: [report('lead-agent', [finding('review_tool_errors', 'snoozed')])] }));
    expect(s.nothingFound).toEqual([]);
  });
});

describe('refetch on focus', () => {
  it('at most every 5 minutes, and never while hidden', () => {
    expect(shouldRefetchOnFocus(null, NOW, false)).toBe(true);
    expect(shouldRefetchOnFocus(NOW - FOCUS_REFETCH_MS + 1, NOW, false)).toBe(false);
    expect(shouldRefetchOnFocus(NOW - FOCUS_REFETCH_MS, NOW, false)).toBe(true);
    expect(shouldRefetchOnFocus(null, NOW, true)).toBe(false);
  });
  it('request gate: only the newest response lands', () => {
    const g = createRequestGate();
    const slow = g.startRead()!;
    const fresh = g.startRead()!;
    expect(g.isCurrent(slow)).toBe(false);
    expect(g.isCurrent(fresh)).toBe(true);
  });
  it('request gate: a read during a check waits, then replays once the check lands', () => {
    const g = createRequestGate();
    const check = g.startCheck();
    expect(g.startRead()).toBeNull();
    expect(g.isCurrent(check)).toBe(true); // the check's result still lands
    expect(g.finish(check, true)).toBe(true); // and the skipped read runs after it
    expect(g.startRead()).not.toBeNull();
  });
  it('request gate: a failed check replays a read, since one in flight when it started was dropped', () => {
    const g = createRequestGate();
    const inFlight = g.startRead()!;
    const check = g.startCheck();
    expect(g.isCurrent(inFlight)).toBe(false);
    expect(g.finish(check, false)).toBe(true);
  });
  it('request gate: nothing skipped means no replay, and a fleet change drops what is in flight', () => {
    const g = createRequestGate();
    const check = g.startCheck();
    expect(g.finish(check, true)).toBe(false);
    const again = g.startCheck();
    g.reset();
    expect(g.isCurrent(again)).toBe(false);
    expect(g.finish(again, true)).toBe(false);
    expect(g.startRead()).not.toBeNull(); // reset also ended the check
  });
  it('relative time', () => {
    expect(relativeTime(new Date(NOW - 20_000).toISOString(), NOW)).toBe('just now');
    expect(relativeTime(new Date(NOW - 3 * 3600_000).toISOString(), NOW)).toBe('3 hours ago');
  });
});


describe('evidence headers', () => {
  it('loops: only the looping tool is grouped, so other calls in the same request can\'t crowd it out', () => {
    const calls = Array.from({ length: 6 }, (_, i) => ({
      requestStart: `2026-09-28T14:0${i}:00Z`, watchNumber: 3,
      toolCallHashes: [{ n: 'search', h: 'aaaa1111' }, { n: `other_${i}`, h: `bbbb${i}` }, { n: `more_${i}`, h: `cccc${i}` }],
    }));
    const h = evidenceHeader('review_tool_loops', calls, { toolName: 'search' });
    expect(h?.kind === 'table' ? h.rows : null).toEqual([['search', 'same · aaaa1111', '6', '3']]);
  });
  const c = (p: Record<string, unknown>) => ({ requestEnd: '2026-09-28T14:02:00Z', ...p });
  it('a call with no time shows a dash, never "Invalid Date"', () => {
    const h = evidenceHeader('review_tool_silence', [{ toolNames: ['persist_lead'], requestedToolNames: [] }], { toolName: 'persist_lead' });
    expect(h?.kind === 'table' ? h.rows[0][0] : null).toBe('—');
  });
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
  it('spend: highest-token calls first', () => {
    const h = evidenceHeader('review_spend_outliers', [c({ reportedModel: 'm', attempts: [{ inputTokens: 10, outputTokens: 5 }] }), c({ reportedModel: 'm', attempts: [{ inputTokens: 900, outputTokens: 100 }] })], {});
    expect(h && h.kind === 'table' && h.rows.map((r) => r[2])).toEqual(['1,000', '15']);
  });
  it('unknown detector ids never throw in What we checked', () => {
    const d = fleet({ reports: [{ ...report('a', []), clear: [{ detector: 'review_new_thing' as DiagnosisDetectorId, note: null }] }] });
    expect(() => checkedSummary(d)).not.toThrow();
    expect(checkedSummary(d).perAgent[0].looksFine).toEqual([]);
  });
  it('other detectors keep the existing view', () => {
    expect(evidenceHeader('review_tool_bloat', [], {})).toBeNull();
  });
});
