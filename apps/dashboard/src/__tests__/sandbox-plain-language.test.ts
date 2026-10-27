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

const JARGON = /\bshifts?\b|hand(s|ed)? over|handover|\bwatch(es)?\b|policy chain|\bsummar(y|ies)\b|\bmemory\b|\bnotes?\b|\bbreaks?\b|where it left off|passed work/i;

describe('Sandbox plain language', () => {
  it('names the three checks the same way everywhere', () => {
    expect(SANDBOX_CHECKS.map((c) => checkLabel(c.id, 'engine name'))).toEqual([
      'Your agent connects',
      'It keeps going on long tasks',
      'It carries on normally',
    ]);
  });

  it('shows the three checks on the start screen, without motion or buttons', () => {
    const html = renderToStaticMarkup(createElement(CheckPreview));
    for (const c of SANDBOX_CHECKS) expect(html).toContain(c.label);
    expect(html).toContain('What the test checks');
    expect(html).toContain('It doesn’t lose its place when a task runs long.');
    expect(html).toContain('You get three pass/fail checks and a report to download.');
    expect(html).not.toContain('WHAT THE TEST CHECKS');
    expect(html).not.toContain('<button');
    expect(html).not.toMatch(/Route|Evidence|aria-live/);
  });

  it('words the waiting memory and resume checks plainly', () => {
    const live = (minutesWorked: number) => ({
      mode: 'connected' as const,
      agents: [{ agentId: 'a', totalTasks: 1, watchMinutes: 2, currentWatch: { minutesWorked } }],
    }) as unknown as Parameters<typeof checkGuidance>[2];
    const waiting = checkGuidance('core.handoff', 'waiting', live(0.5), 'anthropic');
    expect(waiting.detail).toBe('About 1:30 until the long-task check.');
    expect(waiting.action).toBe('Keep your agent making calls. The check runs on its own.');
    expect(checkGuidance('core.handoff', 'waiting', live(2), 'anthropic').detail).toBe('Ready for the long-task check. It happens on your agent’s next call.');
    expect(checkGuidance('core.resume', 'waiting', live(2), 'anthropic').detail).toBe('Happens after the long-task check.');
    for (const g of [waiting, checkGuidance('core.resume', 'waiting', live(2), 'anthropic')]) {
      expect(`${g.detail} ${g.action ?? ''}`).not.toMatch(JARGON);
    }
  });

  it('names saved-progress steps and problems by what the reader sees', () => {
    expect(eventLabel('handover_out')).toBe('Saved progress');
    expect(eventLabel('handover_in')).toBe('Continued the work');
    expect(eventLabel('handover_summary_failed')).toBe('Couldn’t save all progress');
    expect(eventLabel('handover_something_failed')).toBe('Progress problem');
    expect(eventLabel('handover_something_new')).toBe('Progress step');
  });

  it('says what the memory check found in plain words', () => {
    const run = { mode: 'connected' as const, auditLog: [{ id: 'h', timestamp: '2026-10-12T10:00:00Z', type: 'self_handover', agentId: 'a' }] };
    expect(checkGuidance('core.handoff', 'observed', run, 'anthropic').detail).toBe('Kept going once as the task ran long.');
    // Passed with no matching log entry (e.g. a truncated log): no invented count.
    expect(checkGuidance('core.handoff', 'observed', { mode: 'connected' as const, auditLog: [] }, 'anthropic').detail).toBe('Kept its place as the task ran long.');
    expect(checkGuidance('core.resume', 'observed', run, 'anthropic').detail).toBe('Its next call went through normally.');
  });

  it('counts every time it kept going, without saying how', () => {
    const at = '2026-10-12T10:00:00Z';
    const log = (...types: string[]) => ({ mode: 'connected' as const, auditLog: types.map((type, i) => ({ id: String(i), timestamp: at, type, agentId: 'a' })) });
    expect(checkGuidance('core.handoff', 'observed', log('self_handover', 'self_handover', 'paired_handover'), 'anthropic').detail)
      .toBe('Kept going 3 times as the task ran long.');
    expect(checkGuidance('core.handoff', 'observed', log('handover', 'paired_handover'), 'anthropic').detail)
      .toBe('Kept going 2 times as the task ran long.');
  });

  it('labels Activity events without engine jargon', () => {
    expect(eventLabel('policy_chain_verified')).toBe('Controls checked');
    expect(eventLabel('policy_enforcement_verified')).toBe('Control applied');
    expect(eventLabel('policy_decision')).toBe('Control check');
    expect(eventLabel('demo_activity')).toBe('Demo step');
    expect(eventLabel('paired_handover')).toBe('Saved progress and kept going');
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
    '%s has no shift, handover, summary or memory wording in its copy', (rel) => {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\/[^'"`\n]*$/gm, '');
      const strings = code.match(/(['`"])(?:(?!\1)[^\n\\]|\\.)*\1/g) ?? [];
      const jsxText = code.match(/(?<=[>}])[^<>{}\n]+(?=[<{])/g) ?? [];
      // A lone identifier in quotes ('handover', 'self_handover') is an engine type, not copy.
      // Template holes (${s.summary}) are code, not words.
      const copy = [...strings, ...jsxText].map((t) => t.replace(/\$\{[^}]*\}/g, '')).filter((t) => !/^['"`][a-z_.]+['"`]$/.test(t.trim()));
      expect(copy.filter((t) => JARGON.test(t))).toEqual([]);
    });
});
