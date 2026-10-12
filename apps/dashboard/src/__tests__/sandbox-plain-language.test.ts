// Sandbox copy in plain words: the start screen names the same three checks
// the results show, the Activity tab has no engine jargon, and the countdown
// is labelled.

import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null, status: 'unauthenticated' }) }));
vi.mock('@/lib/analytics', () => ({ analytics: { capture: () => {} } }));

const { CheckPreview, checkGuidance, EVENT_LABELS, eventLabel, SANDBOX_STEPS, timerSpoken } = await import('@/components/sandbox/TestRunFlow');
const { checkLabel, SANDBOX_CHECKS } = await import('@/lib/sandbox/report');

const JARGON = /\bshifts?\b|hand(s|ed)? over|handover|\bwatch(es)?\b|policy chain/i;

describe('Sandbox plain language', () => {
  it('names the three checks the same way everywhere', () => {
    expect(SANDBOX_CHECKS.map((c) => checkLabel(c.id, 'engine name'))).toEqual([
      'Your agent connects',
      'It keeps working when its memory fills up',
      'It picks up where it left off',
    ]);
  });

  it('shows the three checks on the start screen, without motion or buttons', () => {
    const html = renderToStaticMarkup(createElement(CheckPreview));
    for (const c of SANDBOX_CHECKS) expect(html).toContain(c.label);
    expect(html).toContain('When your agent’s memory fills up, WhiteRoom saves a short summary so it can keep going.');
    expect(html).toContain('You’ll get three pass/fail checks and a report you can download.');
    expect(html).not.toContain('<button');
    expect(html).not.toMatch(/Route|Evidence|aria-live/);
  });

  it('words the waiting memory and resume checks plainly', () => {
    const live = (minutesWorked: number) => ({
      mode: 'connected' as const,
      agents: [{ agentId: 'a', totalTasks: 1, watchMinutes: 2, currentWatch: { minutesWorked } }],
    }) as unknown as Parameters<typeof checkGuidance>[2];
    const waiting = checkGuidance('core.handoff', 'waiting', live(0.5), 'anthropic');
    expect(waiting.detail).toBe('About 1:30 until WhiteRoom saves a summary.');
    expect(waiting.action).toBe('Keep your agent making calls. The summary is saved on its own.');
    expect(checkGuidance('core.handoff', 'waiting', live(2), 'anthropic').detail).toBe('Ready to save a summary. It happens on your agent’s next call.');
    expect(checkGuidance('core.resume', 'waiting', live(2), 'anthropic').detail).toBe('Happens after the summary is saved.');
    for (const g of [waiting, checkGuidance('core.resume', 'waiting', live(2), 'anthropic')]) {
      expect(`${g.detail} ${g.action ?? ''}`).not.toMatch(JARGON);
    }
  });

  it('names hand-offs and summary problems for what they are', () => {
    expect(eventLabel('handover_out')).toBe('Passed work to another agent');
    expect(eventLabel('handover_in')).toBe('Took over work from another agent');
    expect(eventLabel('handover_summary_failed')).toBe('Couldn’t write a summary');
    expect(eventLabel('handover_something_failed')).toBe('Memory summary problem');
    expect(eventLabel('handover_something_new')).toBe('Memory summary step');
  });

  it('says what the memory check found in plain words', () => {
    const run = { mode: 'connected' as const, auditLog: [{ id: 'h', timestamp: '2026-10-12T10:00:00Z', type: 'self_handover', agentId: 'a' }] };
    expect(checkGuidance('core.handoff', 'observed', run, 'anthropic').detail).toBe('Saved a summary once and kept its context.');
    // Passed with no matching log entry (e.g. a truncated log): no invented count.
    expect(checkGuidance('core.handoff', 'observed', { mode: 'connected' as const, auditLog: [] }, 'anthropic').detail).toBe('Kept its context.');
    expect(checkGuidance('core.resume', 'observed', run, 'anthropic').detail).toBe('Its next call after the summary worked.');
  });

  it('words passing work to another agent apart from saving a summary', () => {
    const at = '2026-10-12T10:00:00Z';
    const log = (...types: string[]) => ({ mode: 'connected' as const, auditLog: types.map((type, i) => ({ id: String(i), timestamp: at, type, agentId: 'a' })) });
    expect(checkGuidance('core.handoff', 'observed', log('self_handover', 'self_handover', 'paired_handover'), 'anthropic').detail)
      .toBe('Saved a summary 2 times and kept its context. Passed work to another agent once.');
    expect(checkGuidance('core.handoff', 'observed', log('handover', 'paired_handover'), 'anthropic').detail)
      .toBe('Kept its context. Passed work to another agent 2 times.');
  });

  it('labels Activity events without engine jargon', () => {
    expect(eventLabel('policy_chain_verified')).toBe('Controls checked');
    expect(eventLabel('policy_enforcement_verified')).toBe('Control applied');
    expect(eventLabel('policy_decision')).toBe('Control check');
    expect(eventLabel('demo_activity')).toBe('Demo step');
    expect(eventLabel('paired_handover')).toBe('Passed work to another agent');
    expect(eventLabel('watch_start')).toBe('Started work');
    for (const label of Object.values(EVENT_LABELS)) expect(label).not.toMatch(JARGON);
    // Engine types with no label of their own still read as plain words.
    for (const type of ['handover_chain_abandoned', 'policy_mode_changed', 'watch_end']) expect(eventLabel(type)).not.toMatch(JARGON);
  });

  it('points the agent at the test URL', () => {
    expect(SANDBOX_STEPS[1]).toEqual({ title: 'Point your agent', sub: 'Use the test URL' });
  });

  it('speaks the countdown in whole minutes', () => {
    expect(timerSpoken(1787, false)).toBe('Test ends in about 30 minutes');
    expect(timerSpoken(1741, false)).toBe('Test ends in about 30 minutes');
    expect(timerSpoken(1739, false)).toBe('Test ends in about 29 minutes');
    expect(timerSpoken(20, false)).toBe('Test ends in about 1 minute');
    expect(timerSpoken(0, false)).toBe('Test ended');
    expect(timerSpoken(100, true)).toBe('Test ended');
  });

  it.each(['../components/sandbox/TestRunFlow.tsx', '../components/sandbox/CloudProviderParts.tsx', '../components/sandbox/PastTests.tsx'])(
    '%s has no shift or handover wording in its copy', (rel) => {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\/[^'"`\n]*$/gm, '');
      const strings = code.match(/(['`"])(?:(?!\1)[^\n\\]|\\.)*\1/g) ?? [];
      const jsxText = code.match(/(?<=[>}])[^<>{}\n]+(?=[<{])/g) ?? [];
      // A lone identifier in quotes ('handover', 'self_handover') is an engine type, not copy.
      const copy = [...strings, ...jsxText].filter((t) => !/^['"`][a-z_.]+['"`]$/.test(t.trim()));
      expect(copy.filter((t) => JARGON.test(t))).toEqual([]);
    });
});
