// Practice test screens as they render (every /dev/practice state), and the
// Sandbox screens they are added to: the additions appear, and nothing else
// changes (D11).

import { describe, expect, it, vi } from 'vitest';
import { createElement, type FC } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RunStatusResult } from '@/lib/sandbox/api';
import type { PracticeEntry } from '@/components/sandbox/practice/PracticeCard';

vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null, status: 'unauthenticated' }) }));
vi.mock('@/lib/analytics', () => ({ analytics: { capture: () => {} } }));

const { PracticeTest } = await import('@/components/sandbox/practice/PracticeTest');
const { PracticeCard } = await import('@/components/sandbox/practice/PracticeCard');
const { PastTests } = await import('@/components/sandbox/PastTests');
const { TestRunFlow } = await import('@/components/sandbox/TestRunFlow');
const { PRACTICE_ROWS, PRACTICE_STATES } = await import('@/app/dev/practice/states');

const render = (state: keyof typeof PRACTICE_STATES) => renderToStaticMarkup(createElement(PracticeTest, { preview: PRACTICE_STATES[state] }));
/** The words a person reads: tags and attributes dropped. */
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const DISCLAIMER = 'Practice tasks use made-up records and WhiteRoom’s test tools, not your agent’s real job. Use the result to help decide, not as a certificate.';

describe('practice test screens', () => {
  it.each(Object.keys(PRACTICE_STATES) as (keyof typeof PRACTICE_STATES)[])('%s: plain words only (rule 7, no "readiness")', (state) => {
    // `Watch` is allowed only as the Controls mode label in a control row.
    const words = text(render(state)).replace(/· Watch\b/g, '');
    expect(words).not.toMatch(/handover|hand over|\bshifts?\b|\bwatch|context|compress|readiness|\battempt|\bprobe|evidence|\bsafe\b|certified|guarantee/i);
  });

  it('setup shows who runs it, cost and cap, the checks, the key and the disclaimer', () => {
    const t = text(render('setup'));
    for (const s of ['Sample agent', 'No code, 1 run. Doesn’t test your agent.', 'Your agent', 'Needs a small adapter.', '1 run', '3 runs',
      'Model: claude-haiku-4-5, the one support-bot used most recently.', 'Never more than 120 calls, including control checks and memory summaries.',
      'Set ANTHROPIC_API_KEY to the key your agent uses with prod-eu.', 'Right result after its memory fills up', 'Loop breaker · Enforce · 2 extra calls',
      'Spend cap · Enforce: not checked (it would need real spending)', 'Start test', 'Start from your computer', DISCLAIMER]) expect(t).toContain(s);
    expect(text(render('setup-new-agent'))).toContain('Model your agent uses');
    // A fleet with no agents yet: the sample agent, since Your agent needs one that has called through WhiteRoom.
    const none = renderToStaticMarkup(createElement(PracticeTest, { preview: { ...PRACTICE_STATES.setup, setup: { ...PRACTICE_STATES.setup.setup!, agents: [] } } }));
    expect(text(none)).toContain('Run your agent through WhiteRoom once first, so it shows up here.');
    const radios = none.match(/<input[^>]*name="practice-who"[^>]*>/g) ?? [];
    expect(radios).toHaveLength(2);
    expect(radios[0]).toContain('checked=""');
    expect(radios[1]).toContain('disabled=""');
    expect(text(render('setup-new-agent'))).toContain('Pause and Stop: not checked on this fleet.');
    expect(text(render('setup-proxy'))).toContain('Practice tests can’t yet run agents that call through a WhiteRoom proxy URL (Azure OpenAI, AWS Bedrock).');
  });

  it('practice tests off: a calm page with the way back, not an error', () => {
    const html = render('unavailable');
    const t = text(html);
    expect(t).toContain('Practice tests aren’t available yet');
    expect(t).toContain('Try again later.');
    expect(html).toMatch(/<a[^>]*href="\/sandbox"[^>]*>← Back to Sandbox<\/a>/);
    expect(html).not.toContain('role="alert"');
    expect(t).not.toMatch(/couldn’t read|Try again<|readiness|WhiteRoom server/i);
    // Even with a refusal left over, only the calm page shows.
    const both = renderToStaticMarkup(createElement(PracticeTest, { preview: { ...PRACTICE_STATES.unavailable, refusal: { message: 'WhiteRoom sent an answer the dashboard couldn’t read. Try again.' } } }));
    expect(both).not.toContain('role="alert"');
  });

  it('refusals say what to do next', () => {
    expect(text(render('refused-today'))).toContain('You can start more tomorrow (00:00 UTC).');
    const open = text(render('refused-open'));
    expect(open).toContain('You already have a practice test open.');
    expect(open).toMatch(/View it.*End it…/);
  });

  it('the terminal steps: the command, then the run code, which is never part of a command', () => {
    const html = render('code');
    const t = text(html);
    expect(t.indexOf('whiteroom practice run --adapter "node wr-adapter.mjs"')).toBeLessThan(t.indexOf('Paste this run code'));
    expect(t).toContain('Expires in 29:48');
    expect(t).toContain('Get a new run code');
    expect(t).toContain('shasum -a 256 whiteroom-ai-cli-2.0.0.tgz');
    expect(t).toContain('Unknown command: practice');
    expect(t).toContain('End test');
    const commands = [...html.matchAll(/<pre[^>]*>([^<]*)<\/pre>/g)].map((m) => m[1]);
    expect(commands.some((c) => c.startsWith('wrrt_'))).toBe(true);
    expect(commands.filter((c) => c.includes('practice')).every((c) => !c.includes('wrrt_'))).toBe(true);
    expect(html).toContain('aria-label="Copy run code"');
    expect(text(render('code-sample'))).not.toContain('starter adapter');
    expect(text(render('code-gone'))).toContain('The run code is shown only once');
  });

  it('running, lost contact and finishing', () => {
    expect(text(render('running'))).toContain('Practice tasks: 4 of 18 done (run 1 of 3)');
    expect(text(render('lost'))).toContain('Lost contact with your computer.');
    expect(text(render('finalizing'))).toContain('Working out the result');
    expect(render('finalizing')).not.toContain('End test');
  });

  it('results: verdict, fixes, how we know, what was tested, next step, disclaimer and retention', () => {
    const passed = text(render('passed'));
    for (const s of ['Passed · all 11 checks · 3 runs', "How we know: Checked against the test tools' records", 'How we know: Seen by WhiteRoom',
      'Call rate · Watch', 'Download report', 'What was tested', '(sent by the CLI, not verified)', 'Adapter (reported by the CLI)', DISCLAIMER,
      'Full details kept until', 'Test r-7f3a']) expect(passed).toContain(s);
    expect(text(render('passed-1run'))).toContain('Run it 3 times');
    const sample = text(render('passed-sample'));
    expect(sample).toContain('WhiteRoom’s sample agent, as support-bot');
    expect(sample).toContain('Reports come from a test of your own agent.');
    expect(sample).not.toContain('Download report');
    const failed = text(render('failed'));
    expect(failed).toMatch(/Didn’t pass · 1 check failed.*What to fix.*Saves once when a tool times out.*Fix: create the key once/);
    expect(failed).toContain('Rerun failed checks');
    const incomplete = text(render('incomplete'));
    expect(incomplete).toMatch(/What stopped the test.*Test problem \(not your agent\): Anthropic hit a rate limit or quota \(HTTP 429\)\./);
    expect(incomplete).toContain('Rerun checks that didn’t run');
    const ended = text(render('ended'));
    expect(ended).toMatch(/Didn’t finish.*What stopped the test.*You ended the test from the dashboard\..*Start a new test/);
  });

  it('confirms a rerun’s cost and ending a test before acting', () => {
    expect(text(render('confirm-rerun'))).toMatch(/Rerun 1 check × 3 runs · usually \d+–\d+ model calls .*never more than \d+\..*Get run code/);
    const end = render('confirm-end');
    expect(end).toContain('role="alertdialog"');
    expect(text(end)).toMatch(/End this practice test\?.*Finished practice tasks are kept.*Your live agents aren’t affected\./);
  });
});

describe('the Sandbox screens practice tests are added to', () => {
  const sandboxOnly = [
    { sandboxId: 's2', destroyedAt: '2026-10-11T10:00:00Z', overall: 'pass' as const, totalTasks: 4, isTrial: false },
    { sandboxId: 's1', destroyedAt: '2026-10-10T10:00:00Z', overall: 'pass' as const, totalTasks: 6, isTrial: true },
  ];

  it('Past tests without practice tests renders exactly as before', () => {
    const before = renderToStaticMarkup(createElement(PastTests, { preview: sandboxOnly }));
    expect(renderToStaticMarkup(createElement(PastTests, { preview: sandboxOnly, practice: [] }))).toBe(before);
    expect(before).not.toContain('Practice');
    expect(before).toContain('90px');
  });

  it('adds finished practice tests as rows, newest first; open ones stay on the card', () => {
    const rows = [...PRACTICE_ROWS, { ...PRACTICE_ROWS[0], id: 'r-00000000-0000-4000-8000-000000000000', lifecycle: 'active' as const, endedAt: null }];
    const t = text(renderToStaticMarkup(createElement(PastTests, { preview: sandboxOnly, practice: rows })));
    expect(t).toMatch(/Passed 15\/15 Practice/);
    expect(t).toMatch(/Rerun · passed \(1 check\) 3\/3 Practice/);
    expect(t).toMatch(/Didn’t finish — Practice \(sample\)/);
    expect(t).toMatch(/All checks passed 4 Your agent/);
    expect(t).toContain('Past tests 6');
    const open = renderToStaticMarkup(createElement(PastTests, { preview: sandboxOnly, practice: rows, previewOpen: PRACTICE_ROWS[0].id }));
    expect(text(open)).toMatch(/Practice test ended .* 11 of 11 checks passed .* WhiteRoom keeps each practice test’s full details for 7 days and its result for 30 days\. Open the result/);
  });

  it('the start screen card, only once practice tests answered', () => {
    expect(renderToStaticMarkup(createElement(PracticeCard, { entry: { fleet: 'prod-eu', rows: null, open: null } }))).toBe('');
    expect(text(renderToStaticMarkup(createElement(PracticeCard, { entry: { fleet: 'prod-eu', rows: [], open: null } }))))
      .toContain('Try your agent on practice tasks 5 practice tasks and a check of your controls, about 30 min, about 50 model calls on your own key. Set up a practice test →');
  });

  it('Ready to go live gains one line, only when practice tests are available', () => {
    const passed = { sandboxId: 'p', mode: 'connected' as const, expiresInSeconds: 900, agents: [],
      controls: ['core.connect', 'core.handoff', 'core.resume'].map((controlId) => ({ controlId, name: controlId, result: { liveEvidence: { status: 'observed' } } })) } as unknown as RunStatusResult;
    const flow = (practice: PracticeEntry) => text(renderToStaticMarkup(createElement(TestRunFlow as FC<NonNullable<Parameters<typeof TestRunFlow>[0]>>, { previewUserId: 'u', previewRun: passed, previewPractice: practice })));
    const line = 'Want more confidence before going live? Run a practice test : 5 practice tasks plus a check of your controls, about 30 minutes.';
    const without = flow({ fleet: null, rows: null, open: null });
    expect(without).toContain('Ready to go live');
    expect(without).not.toContain('practice test');
    const withLine = flow({ fleet: 'prod-eu', rows: [], open: null });
    expect(withLine).toContain(line);
    // Everything else on the card is as it was.
    expect(withLine.replace(` ${line}`, '')).toBe(without);
  });
});
