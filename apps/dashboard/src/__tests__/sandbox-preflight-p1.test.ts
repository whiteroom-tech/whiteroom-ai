// Sandbox pre-flight Phase 1 (spec Oct 28 §7, §9): setup lists one line per
// rule type with duplicates flagged; a demo has no countdown, no test ID and
// a plain End; the loading states are skeletons from @whiteroom/ui.

import { describe, expect, it, vi } from 'vitest';
import { createElement, type FC } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SkeletonCard } from '@whiteroom/ui';
import type { RunStatusResult } from '@/lib/sandbox/api';
import type { PracticeControlCheck } from '@/lib/sandbox/practice/types';

vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null, status: 'unauthenticated' }) }));
vi.mock('@/lib/analytics', () => ({ analytics: { capture: () => {} } }));

const { controlCalls, controlTypeLines, PRACTICE_SUMMARY, shownControls } = await import('@/lib/sandbox/practice/model');
const { isEmptyKeywordRule, parseControlLabel } = await import('@/lib/sandbox/practice/engine-labels');
const { TestRunFlow } = await import('@/components/sandbox/TestRunFlow');
const { PracticeSetup } = await import('@/components/sandbox/practice/PracticeSetup');

const rule = (id: string, label: string, mode: string | null, calls: number | null, note: string | null = null, agents: PracticeControlCheck['agents'] = 'all'): PracticeControlCheck =>
  ({ id, label, mode, agents, checked: note === null, note, calls });
const SPEND = 'Not checked: it would need real spending.';

// Labels below are in the engine's exact formats (engine apps/engine/src/readiness/controls.ts:135-176,
// ruleDetail + ruleLabels): a lone rule is just its name; with several of a type, each carries its
// settings, then ", for <agents>" when scoped; rows alike in settings and mode get " #n".
describe('engine control labels (engine-labels.ts)', () => {
  it('reads every engine label format', () => {
    expect(parseControlLabel('Spend cap')).toEqual({ name: 'Spend cap', settings: null, n: null });
    expect(parseControlLabel('Spend cap (100,000 tokens a day)')).toEqual({ name: 'Spend cap', settings: '100,000 tokens a day', n: null });
    expect(parseControlLabel('Spend cap ($5 a run, for alpha, beta)')).toEqual({ name: 'Spend cap', settings: '$5 a run, for alpha, beta', n: null });
    expect(parseControlLabel('Spend cap (100,000 tokens a day) #2')).toEqual({ name: 'Spend cap', settings: '100,000 tokens a day', n: 2 });
    expect(parseControlLabel('Loop breaker (same call 3 times a run)').settings).toBe('same call 3 times a run');
    expect(parseControlLabel('Call rate (over 60 calls a minute, for a, b and 2 more)').settings).toBe('over 60 calls a minute, for a, b and 2 more');
    expect(parseControlLabel('Model allowlist (claude-haiku-4-5, gpt-4o-mini) #3')).toEqual({ name: 'Model allowlist', settings: 'claude-haiku-4-5, gpt-4o-mini', n: 3 });
    expect(parseControlLabel('Pause and Stop')).toEqual({ name: 'Pause and Stop', settings: null, n: null });
  });

  it('spots a keyword rule with no keywords, scoped or not, and nothing else', () => {
    expect(isEmptyKeywordRule({ id: 'ctl.keyword.k1', label: 'Keywords (0 keywords)' })).toBe(true);
    expect(isEmptyKeywordRule({ id: 'ctl.keyword.k1', label: 'Keywords (0 keywords, for alpha)' })).toBe(true);
    expect(isEmptyKeywordRule({ id: 'ctl.keyword.k1', label: 'Keywords (0 keywords) #2' })).toBe(true);
    expect(isEmptyKeywordRule({ id: 'ctl.keyword.k1', label: 'Keywords (1 keyword)' })).toBe(false);
    expect(isEmptyKeywordRule({ id: 'ctl.keyword.k1', label: 'Keywords (10 keywords)' })).toBe(false);
    // A lone keyword rule carries no settings, so it can't be judged empty (E1 fixes this in the engine).
    expect(isEmptyKeywordRule({ id: 'ctl.keyword.k1', label: 'Keywords' })).toBe(false);
    expect(isEmptyKeywordRule({ id: 'ctl.tool_list.t1', label: 'Tool list (0 keywords)' })).toBe(false);
  });
});

describe('setup rule list: one line per rule type', () => {
  it('groups by the rule type in the check id, with count, modes, calls and the shared reason', () => {
    const cap = 'Spend cap (100,000 tokens a day)';
    const checks = [
      rule('ctl.pause_stop', 'Pause and Stop', null, 1),
      ...Array.from({ length: 5 }, (_, i) => rule(`ctl.spend_cap.s${i}`, i ? `${cap} #${i + 1}` : cap, 'Enforce', null, SPEND)),
      rule('ctl.spend_cap.s5', cap, 'Watch', null, SPEND),
      rule('ctl.spend_cap.s6', 'Spend cap ($5 a run)', 'Watch', null, SPEND),
      rule('ctl.loop_breaker.l1', 'Loop breaker', 'Enforce', 2),
      rule('ctl.call_rate.c1', 'Call rate (over 10 calls a minute)', 'Watch', 6),
      rule('ctl.call_rate.c2', 'Call rate (over 20 calls a minute)', 'Enforce', 6),
      rule('ctl.keyword.k1', 'Keywords (0 keywords)', 'Enforce', 0),
      rule('ctl.keyword.k2', 'Keywords (3 keywords)', 'Watch', 1),
    ];
    expect(controlTypeLines(checks).map((l) => l.text)).toEqual([
      'Pause and Stop · 1 extra call',
      `Spend cap · 7 rules · 5 identical spend caps · 5 Enforce, 2 Watch · ${SPEND}`,
      'Loop breaker · Enforce · 2 extra calls',
      'Call rate · 2 rules · 1 Enforce, 1 Watch · 12 extra calls',
      'Keywords · Watch · 1 extra call',
    ]);
  });

  it('doesn’t call rules identical when their limits differ', () => {
    const lines = controlTypeLines([
      rule('ctl.spend_cap.a', 'Spend cap (100,000 tokens a day)', 'Enforce', null, SPEND),
      rule('ctl.spend_cap.b', 'Spend cap (50,000 tokens a run)', 'Enforce', null, SPEND),
    ]);
    expect(lines[0].text).toBe(`Spend cap · 2 rules · Enforce · ${SPEND}`);
  });

  it('doesn’t call rules identical when they cover different agents', () => {
    // The engine's agent list is cut short ("a, b and 2 more"), so the agents themselves are compared too.
    const label = 'Call rate (over 10 calls a minute, for a, b and 2 more)';
    const lines = controlTypeLines([
      rule('ctl.call_rate.a', label, 'Enforce', 3, null, ['a', 'b', 'c', 'd']),
      rule('ctl.call_rate.b', label, 'Enforce', 3, null, ['a', 'b', 'e', 'f']),
    ]);
    expect(lines[0].text).toBe('Call rate · 2 rules · Enforce · 6 extra calls');
  });

  it('flags rules with the same settings, mode and agents', () => {
    const label = 'Loop breaker (same call 3 times a run, for alpha)';
    const lines = controlTypeLines([
      rule('ctl.loop_breaker.a', label, 'Enforce', 2, null, ['alpha']),
      rule('ctl.loop_breaker.b', `${label} #2`, 'Enforce', 2, null, ['alpha']),
    ]);
    expect(lines[0].text).toBe('Loop breaker · 2 rules · 2 identical loop breakers · Enforce · 4 extra calls');
  });

  it('never claims identical when the labels carry no settings', () => {
    const lines = controlTypeLines([rule('ctl.tool_list.a', 'Tool list', 'Enforce', null, 'Not checked yet.'), rule('ctl.tool_list.b', 'Tool list', 'Enforce', null, 'Not checked yet.')]);
    expect(lines[0].text).toBe('Tool list · 2 rules · Enforce · Not checked yet.');
  });

  it('says how many of a type can’t be checked when some can', () => {
    const lines = controlTypeLines([
      rule('ctl.model_allowlist.a', 'Model allowlist (claude-haiku-4-5)', 'Enforce', 0),
      rule('ctl.model_allowlist.b', 'Model allowlist (no models)', 'Enforce', null, 'Not checked: no models are on the list yet.'),
    ]);
    expect(lines.map((l) => l.text)).toEqual(['Model allowlist · 2 rules · Enforce · no extra calls · 1 not checked: no models are on the list yet.']);
  });

  it('hides keyword rules with no keywords, even when they are all there is', () => {
    expect(controlTypeLines([
      rule('ctl.keyword.k1', 'Keywords (0 keywords)', 'Enforce', 0), rule('ctl.keyword.k2', 'Keywords (0 keywords) #2', 'Enforce', 0),
    ])).toEqual([]);
  });

  it('leaves an empty keyword rule out of the list and the cost alike', () => {
    const checks = [rule('ctl.loop_breaker.l1', 'Loop breaker', 'Enforce', 2), rule('ctl.keyword.k1', 'Keywords (0 keywords)', 'Enforce', 4), rule('ctl.keyword.k2', 'Keywords (2 keywords)', 'Watch', 1, 'Not checked yet.')];
    expect(shownControls(checks).map((c) => c.id)).toEqual(['ctl.loop_breaker.l1', 'ctl.keyword.k2']);
    expect(controlTypeLines(checks).map((l) => l.text)).toEqual(['Loop breaker · Enforce · 2 extra calls', 'Keywords · Watch · Not checked yet.']);
    expect(controlCalls(checks)).toBe(3);
    expect(controlCalls(checks, ['ctl'])).toBe(3);
    // Setup's cost line counts the same calls the list shows, whatever total the engine sent.
    const setup = (cs: PracticeControlCheck[], calls: number) => renderToStaticMarkup(createElement(PracticeSetup, {
      fleet: 'prod-eu', data: { agents: ['support-bot'] }, busy: false, onStart: () => {},
      preview: { model: 'claude-haiku-4-5', provider: 'direct-anthropic', directKey: true, blocked: null, providerKeys: [], controls: { checks: cs, calls } },
    }));
    const cost = (html: string) => html.match(/On the key you test with:[^<]*/)?.[0];
    const withEmpty = setup(checks, 6);
    expect(cost(withEmpty)).toBeTruthy();
    expect(cost(withEmpty)).toBe(cost(setup([checks[0], checks[2]], 3)));
    expect(withEmpty).not.toContain('0 keywords');
  });

  it('the summary line counts no model calls of its own', () => {
    expect(PRACTICE_SUMMARY).toBe('5 practice tasks and a check of your rules · about 5–10 min for one run');
  });
});

describe('the demo', () => {
  const render = (previewRun: RunStatusResult) => renderToStaticMarkup(createElement(TestRunFlow as FC<NonNullable<Parameters<typeof TestRunFlow>[0]>>, { previewUserId: 'u', previewPastTests: [], previewRun }));
  const run = (o: Partial<RunStatusResult>): RunStatusResult => ({ sandboxId: '7f3a0000-0000-4000-8000-000000000000', mode: 'connected', expiresInSeconds: 1500, agents: [], auditLog: [], controls: [], ...o });

  it('has no countdown and no test ID; a live test keeps both', () => {
    const demo = render(run({ mode: 'demo' }));
    expect(demo).not.toContain('Test ends in');
    // The footer says Demo, not the test's ID.
    expect(demo).not.toContain('Test 7f3a0000');
    expect(demo).toMatch(/class="[^"]*footer[^"]*">Demo</);
    expect(demo).toContain('End test');
    const live = render(run({}));
    expect(live).toContain('Test ends in');
    expect(live).toContain('Test 7f3a0000-0000-4000-8000-000000000000');
  });

  it('says the 30 minutes is the test link’s lifetime: the timer’s title and the ended notice', () => {
    expect(render(run({}))).toContain('title="The test link lasts 30 minutes, then the test ends. Results stay in Past tests."');
    expect(render(run({ expiresInSeconds: 0 }))).toContain('This test has ended (the test link lasts 30 minutes). Your results are below.');
  });
});

describe('loading skeleton', () => {
  it('is a busy status with the words for screen readers only', () => {
    const html = renderToStaticMarkup(createElement(SkeletonCard, { label: 'Checking for a practice test…' }));
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Checking for a practice test…');
    expect(html.match(/aria-hidden="true"/g)).toHaveLength(3);
  });
});
