// Sandbox pre-flight Phase 1 (spec Oct 28 §7, §9): the connection test's
// countdown says it is the link's lifetime; the loading states are skeletons
// from @whiteroom/ui. Phase 2's rows: sandbox-preflight.test.ts.

import { describe, expect, it, vi } from 'vitest';
import { createElement, type FC } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SkeletonCard } from '@whiteroom/ui';
import type { RunStatusResult } from '@/lib/sandbox/api';

vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null, status: 'unauthenticated' }) }));
vi.mock('@/lib/analytics', () => ({ analytics: { capture: () => {} } }));

const { TestRunFlow } = await import('@/components/sandbox/TestRunFlow');

describe('a live connection test', () => {
  const render = (previewRun: RunStatusResult) => renderToStaticMarkup(createElement(TestRunFlow as FC<NonNullable<Parameters<typeof TestRunFlow>[0]>>, { previewUserId: 'u', previewPastTests: [], previewRun }));
  const run = (o: Partial<RunStatusResult>): RunStatusResult => ({ sandboxId: '7f3a0000-0000-4000-8000-000000000000', mode: 'connected', expiresInSeconds: 1500, agents: [], auditLog: [], controls: [], ...o });

  it('a live test shows its countdown and its test ID', () => {
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
