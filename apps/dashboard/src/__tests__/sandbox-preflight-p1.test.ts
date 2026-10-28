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

const { controlTypeLines, PRACTICE_SUMMARY } = await import('@/lib/sandbox/practice/model');
const { TestRunFlow, endTestAction } = await import('@/components/sandbox/TestRunFlow');

const rule = (id: string, label: string, mode: string | null, calls: number | null, note: string | null = null): PracticeControlCheck =>
  ({ id, label, mode, agents: 'all', checked: note === null, note, calls });
const SPEND = 'Not checked: it would need real spending.';

describe('setup rule list: one line per rule type', () => {
  it('groups by the rule type in the check id, with count, modes, calls and the shared reason', () => {
    const checks = [
      rule('ctl.pause_stop', 'Pause and Stop', null, 1),
      ...Array.from({ length: 5 }, (_, i) => rule(`ctl.spend_cap.s${i}`, i ? `Spend cap #${i + 1}` : 'Spend cap', 'Enforce', null, SPEND)),
      rule('ctl.spend_cap.s5', 'Spend cap #6', 'Watch', null, SPEND),
      rule('ctl.spend_cap.s6', 'Spend cap #7', 'Watch', null, SPEND),
      rule('ctl.loop_breaker.l1', 'Loop breaker', 'Enforce', 2),
      rule('ctl.call_rate.c1', 'Call rate', 'Watch', 6),
      rule('ctl.call_rate.c2', 'Call rate #2', 'Enforce', 6),
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

  it('says how many of a type can’t be checked when some can', () => {
    const lines = controlTypeLines([rule('ctl.model_allowlist.a', 'Model allowlist', 'Enforce', 0), rule('ctl.model_allowlist.b', 'Model allowlist #2', 'Enforce', null, 'Not checked: no model to try.')]);
    expect(lines.map((l) => l.text)).toEqual(['Model allowlist · 2 rules · 2 identical model allowlists · Enforce · no extra calls · 1 not checked: no model to try.']);
  });

  it('hides keyword rules with no keywords, even when they are all there is', () => {
    expect(controlTypeLines([rule('ctl.keyword.k1', 'Keywords (0 keywords)', 'Enforce', 0)])).toEqual([]);
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

describe('End test', () => {
  it('ends a demo at once and asks first on a live test', () => {
    expect(endTestAction(true)).toBe('end');
    expect(endTestAction(false)).toBe('confirm');
  });
});
