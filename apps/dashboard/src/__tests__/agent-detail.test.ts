import { describe, expect, it } from 'vitest';
import { agentHealthLine, agentIdFromSegment, breakEndsAt, canPause, canResume, headerAction, isNotFound, lastModel, nowCard, statusWords, weekRuleWords } from '@/lib/agent-detail';
import type { AgentInfo, AuditEntry, FleetDiagnosis, RunSummary } from '@/lib/whiteroom/types';
import { agentState } from '@/lib/home';

const now = Date.parse('2026-10-01T14:00:00Z');
const working: AgentInfo = { agentId: 'lead-agent', status: 'working', minutesRemaining: 3.2, percentComplete: '41%', watchNumber: 8, tasksCompleted: 62, minutesWorked: 9.44, tokensUsed: 12_400 };
const resting = (x: Partial<AgentInfo> = {}): AgentInfo => ({ agentId: 'scout-agent', status: 'resting', ...x });

describe('break timing', () => {
  it('prefers the alarm, else start + restMinutes (a manual break has no alarm)', () => {
    expect(breakEndsAt({ alarmAt: '2026-10-01T14:05:00Z' })).toBe(Date.parse('2026-10-01T14:05:00Z'));
    expect(breakEndsAt({ restStartedAt: '2026-10-01T13:58:00Z', restMinutes: 2 })).toBe(Date.parse('2026-10-01T14:00:00Z'));
    expect(breakEndsAt({})).toBeNull();
  });
});

describe('what the operator may do', () => {
  it('pauses any agent that isn\'t held on a Gov v1 fleet, and only a working one on an older fleet', () => {
    expect(canPause({ agentId: 'a', status: 'idle', govV1: true }).allowed).toBe(true);
    expect(canPause({ agentId: 'a', status: 'idle', govV1: true, hold: { state: 'paused', by: 'x', reason: null, at: '2026-10-01T13:00:00Z' } })).toEqual({ allowed: false, why: 'It’s already paused.' });
    expect(canPause(working).allowed).toBe(true);
    expect(canPause(resting())).toEqual({ allowed: false, why: 'It is already paused.' });
    expect(canPause({ agentId: 'a', status: 'idle' })).toEqual({ allowed: false, why: 'Only a working agent can be paused.' });
  });

  it('resumes once it can, and says how long is left', () => {
    expect(canResume(working, now)).toEqual({ allowed: false, why: 'It isn’t paused.' });
    expect(canResume(resting({ alarmAt: '2026-10-01T14:03:30Z' }), now)).toEqual({ allowed: false, why: 'It can resume in 4 min.' });
    expect(canResume(resting({ alarmAt: '2026-10-01T13:59:00Z' }), now).allowed).toBe(true);
    // Unknown end: let the engine decide (its answer is shown if it refuses).
    expect(canResume(resting(), now).allowed).toBe(true);
  });

  it('offers one header action: Resume while held or paused, else Pause', () => {
    expect(headerAction(working)).toBe('pause');
    expect(headerAction(resting())).toBe('resume');
    expect(headerAction({ agentId: 'a', status: 'idle', hold: { state: 'stopped', by: 'x', reason: null, at: '2026-10-01T13:00:00Z' } })).toBe('resume');
  });

  it('words the status without a pill', () => {
    expect(statusWords('idle')).toEqual({ text: 'Waiting for work', tone: 'muted' });
    expect(statusWords('working').text).toBe('Working');
    expect(statusWords('handover').text).toBe('Working');
    expect(statusWords('paused').text).toBe('Paused');
    expect(statusWords('pausing').text).toBe('Pausing…');
  });
});

describe('the Now card', () => {
  const date = (iso: string) => iso.slice(5, 10);
  const run = (shift: number): RunSummary => ({ runId: `a~${shift}`, agentId: 'a', shift, startedAt: '2026-10-24T20:45:00Z', endedAt: '2026-10-24T20:45:24Z', lengthSeconds: 24, calls: 6, failedCalls: 0, blockedCalls: 0, wouldActCalls: 0, spendMicros: 0, unpricedAttempts: 0, coverage: { calls: 6, checked: 6 }, flags: [] });
  it('shows the last run, linked when Recent runs has it, and the all-time totals', () => {
    const idle: AgentInfo = { agentId: 'a', status: 'idle', currentShift: null, lastShift: { watchNumber: 4, tokensUsed: 900, tasksCompleted: 6, minutesWorked: 0.4 }, lifetime: { tokensUsed: 53_400, tasksCompleted: 60, minutesWorked: 40 } };
    expect(nowCard(idle, [run(4)], date)).toEqual({ status: 'Not running', run: { label: 'Last run', number: 4, tail: '6 tasks' }, runId: 'a~4', runDate: '10-24', allTime: 'All time: 60 tasks · 53.4K tokens' });
    expect(nowCard(idle, null, date).runId).toBeNull();
  });
  it('shows the run in progress, and never lifetime totals as a run (M14)', () => {
    expect(nowCard(working, [], date)).toMatchObject({ status: 'Running', run: { label: 'Run', number: 8, tail: '62 tasks · 9.4 min so far' }, allTime: null });
    // Older engine: an idle agent's flat fields are lifetime totals, so no run is claimed.
    expect(nowCard({ agentId: 'a', status: 'idle', watchNumber: 41, tasksCompleted: 332 }, [], date).run).toBeNull();
  });
  it('says Paused or Stopped while held', () => {
    expect(nowCard({ agentId: 'a', status: 'working', hold: { state: 'stopped', by: 'x', reason: null, at: '2026-10-01T13:00:00Z' } }, [], date).status).toBe('Stopped');
  });
});

describe('Last 7 days rule activity', () => {
  it('says blocked and would have blocked, or 0 caught', () => {
    expect(weekRuleWords({ blocks: 2, wouldBlocks: 58 })).toEqual([{ count: 2, word: 'blocked' }, { count: 58, word: 'would have blocked' }]);
    expect(weekRuleWords({ blocks: 0, wouldBlocks: 60 })).toEqual([{ count: 60, word: 'would have blocked' }]);
    expect(weekRuleWords({ blocks: 0, wouldBlocks: 0 })).toEqual([{ count: 0, word: 'caught' }]);
  });
});

describe('health line', () => {
  const base: FleetDiagnosis = { checkedAt: '2026-10-01T12:00:00Z', source: 'background', reports: [], waiting: [], skipped: [], truncated: false, readyAgents: 1, busiest: null, minCalls: 50 };
  const report = (findings: FleetDiagnosis['reports'][number]['findings']): FleetDiagnosis['reports'][number] => ({ schema: 'diagnosis.v1', agentId: 'a', window: { from: '', to: '', days: 7, calls: 100, watches: 3 }, findings, clear: [{ detector: 'review_tool_errors', note: null }], notMeasured: [] });
  const finding = { recommendationId: 'r', findingId: 'f', findingVersion: 1, detector: 'review_tool_loops' as const, detectorVersion: 1, status: 'open', measures: {}, estWastedTokens: null, estWastedCostMicros: null, evidenceCallIds: [], coverage: 'full', limitations: null, suggestedAction: { kind: 'rule' as const, rule: 'loop_breaker' as const, mode: 'watch' as const, appliesTo: ['a'], params: {} } };
  it('names an open problem, or what passed, with when it was checked', () => {
    expect(agentHealthLine({ ...base, reports: [report([finding])] }, 'a', now)).toEqual({ tone: 'warn', text: '1 problem: Repeating the same call · checked 2 hours ago' });
    expect(agentHealthLine({ ...base, reports: [report([])] }, 'a', now)).toEqual({ tone: 'ok', text: '1 check passed · checked 2 hours ago' });
  });
  it('is quiet when the check is off or hasn\'t looked at the agent', () => {
    expect(agentHealthLine(null, 'a', now)).toBeNull();
    expect(agentHealthLine({ ...base, checkedAt: null }, 'a', now)).toBeNull();
    expect(agentHealthLine(base, 'a', now)).toBeNull();
    expect(agentHealthLine({ ...base, waiting: [{ agentId: 'a', calls7d: 3 }] }, 'a', now)?.text).toBe('Waiting for more calls before the first check');
  });
});

describe('details', () => {
  it('takes the model from the newest entry that names one', () => {
    const e = (ts: string, model?: string) => ({ id: ts, type: 'task_complete', timestamp: ts, model }) as AuditEntry;
    expect(lastModel([e('2026-10-01T13:00:00Z', 'claude-haiku-4-5'), e('2026-10-01T13:30:00Z', 'claude-sonnet-4-5'), e('2026-10-01T13:45:00Z')])).toBe('claude-sonnet-4-5');
    expect(lastModel([])).toBeNull();
  });

  it('recognises the engine\'s not-found answer', () => {
    expect(isNotFound({ error: "Agent 'x' not found." })).toBe(true);
    expect(isNotFound({ error: 'Fleet unavailable' })).toBe(false);
    expect(isNotFound({ agentId: 'x', status: 'working' })).toBe(false);
  });
});

describe('agent ids from the URL', () => {
  it('decodes, and keeps a malformed escape raw instead of crashing', () => {
    expect(agentIdFromSegment('lead%20agent')).toBe('lead agent');
    expect(agentIdFromSegment('%E0%A4%A')).toBe('%E0%A4%A');
  });
});

describe('durable holds (P2.2)', () => {
  const held = (state: 'paused' | 'stopped') => ({ agentId: 'a', status: 'working', hold: { state, by: 'dashboard', reason: null, at: '2026-10-01T18:00:00Z' } });
  it('shows a held agent as paused or stopped, whatever its watch status', () => {
    expect(agentState(held('paused'))).toBe('paused');
    expect(agentState(held('stopped'))).toBe('stopped');
    expect(agentState({ ...held('paused'), hold: null })).toBe('working');
  });
  it('lets a held agent resume right away', () => {
    expect(canResume(held('stopped'))).toEqual({ allowed: true });
  });
});
