import { describe, expect, it } from 'vitest';
import { agentIdFromSegment, notesAreLong, breakEndsAt, canResume, canStartBreak, handoverLines, isNotFound, lastModel, notesStatus, shiftProgress, shiftSummary } from '@/lib/agent-detail';
import type { AgentInfo, AuditEntry } from '@/lib/whiteroom/types';
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
  it('starts a break only for a working agent', () => {
    expect(canStartBreak(working).allowed).toBe(true);
    expect(canStartBreak(resting()).allowed).toBe(false);
    expect(canStartBreak({ agentId: 'a', status: 'idle' })).toEqual({ allowed: false, why: 'Only a working agent can be sent on a break.' });
  });

  it('resumes only after the mandatory break, and says how long is left', () => {
    expect(canResume(working, now)).toEqual({ allowed: false, why: 'It isn’t on a break.' });
    expect(canResume(resting({ alarmAt: '2026-10-01T14:03:30Z' }), now)).toEqual({ allowed: false, why: 'The break is mandatory; it can resume in 4 min.' });
    expect(canResume(resting({ alarmAt: '2026-10-01T13:59:00Z' }), now).allowed).toBe(true);
    // Unknown end: let the engine decide (its answer is shown if it refuses).
    expect(canResume(resting(), now).allowed).toBe(true);
  });
});

describe('progress and summary', () => {
  it('shows shift progress with minutes left', () => {
    expect(shiftProgress(working, now)).toEqual({ pct: 41, onBreak: false, label: '41% · 3.2 min left' });
  });

  it('shows break progress while resting', () => {
    expect(shiftProgress(resting({ restPercent: '50', alarmAt: '2026-10-01T14:02:00Z' }), now)).toEqual({ pct: 50, onBreak: true, label: '50% of the break · 2 min left' });
  });

  it('clamps junk percentages', () => {
    expect(shiftProgress({ ...working, percentComplete: '140%' }, now)!.pct).toBe(100);
    expect(shiftProgress({ ...working, percentComplete: 'n/a' }, now)!.pct).toBe(0);
  });

  it('summarises the shift', () => {
    expect(shiftSummary(working, (n) => `${n / 1000}K`)).toBe('#8 · 62 tasks · 9.4 min worked · 12.4K tokens');
    expect(shiftSummary({ agentId: 'a', status: 'idle' }, String)).toBe('none running');
  });

  it('never shows lifetime totals as the current shift (M14)', () => {
    const idle = { agentId: 'a', status: 'idle', currentShift: null, lastShift: { watchNumber: 41, tokensUsed: 900, tasksCompleted: 5, minutesWorked: 0.4 }, lifetime: { tokensUsed: 4_030_000, tasksCompleted: 332, minutesWorked: 40 } };
    expect(shiftSummary(idle, (n) => `${n / 1e6}M`)).toBe('none running · last #41: 5 tasks · lifetime 332 tasks, 4.03M tokens');
    // Older engine: an idle agent's flat fields are lifetime totals, so no shift is claimed.
    expect(shiftSummary({ agentId: 'a', status: 'idle', watchNumber: 41, tasksCompleted: 332, tokensUsed: 4_030_000 }, String)).toBe('none running');
    expect(shiftProgress(idle)).toBeNull(); // no made-up 0% bar
    expect(shiftProgress({ agentId: 'a', status: 'idle', percentComplete: '0%' })).toBeNull();
  });
});

describe('details', () => {
  it('takes the model from the newest entry that names one', () => {
    const e = (ts: string, model?: string) => ({ id: ts, type: 'task_complete', timestamp: ts, model }) as AuditEntry;
    expect(lastModel([e('2026-10-01T13:00:00Z', 'claude-haiku-4-5'), e('2026-10-01T13:30:00Z', 'claude-sonnet-4-5'), e('2026-10-01T13:45:00Z')])).toBe('claude-sonnet-4-5');
    expect(lastModel([])).toBeNull();
  });

  it('turns handover notes into labelled lines, skipping empty parts', () => {
    expect(handoverLines({ state: 'Triaging batch', pending: [{ task: 'policy lookup' }, { task: '' }], warnings: [] })).toEqual([
      { label: 'State', text: 'Triaging batch' },
      { label: 'Pending', text: 'policy lookup' },
    ]);
    expect(handoverLines(null)).toEqual([]);
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

describe('handover notes per shift', () => {
  it('shows notes only for the shift they belong to', () => {
    expect(notesStatus(8, 8, false)).toBe('current');
    expect(notesStatus(null, null, false)).toBe('current');
    // The agent moved on to shift 9: shift 8's notes are out of date.
    expect(notesStatus(8, 9, false)).toBe('loading');
    expect(notesStatus(8, 9, true)).toBe('failed');
    expect(notesStatus(undefined, 1, false)).toBe('loading');
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

describe('handover notes length', () => {
  it('collapses only notes longer than a few lines', () => {
    expect(notesAreLong([{ text: 'Triaging the 2:00 pm batch.' }])).toBe(false);
    expect(notesAreLong([{ text: 'x'.repeat(200) }, { text: 'y'.repeat(200) }])).toBe(true);
  });
});
