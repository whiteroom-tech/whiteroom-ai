// Practice test screens as they render (every /dev/practice state), and the
// Sandbox screens they are added to: the additions appear, and nothing else
// changes (D11).

import { describe, expect, it, vi } from 'vitest';
import { createElement, type FC } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RunStatusResult } from '@/lib/sandbox/api';
import type { PracticeEntry } from '@/components/sandbox/practice/PracticeCard';
import type { PracticeControlCheck } from '@/lib/sandbox/practice/types';

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
// The catalog's words (straight apostrophes), as the CLI prints them too.
const DISCLAIMER = "Practice tasks use made-up records and WhiteRoom's test tools, not your agent's real job. Use the result to help decide, not as a certificate.";

describe('practice test screens', () => {
  it.each(Object.keys(PRACTICE_STATES) as (keyof typeof PRACTICE_STATES)[])('%s: plain words only (rule 7, no "readiness")', (state) => {
    // `Watch` is allowed only as the Controls mode label in a control row.
    const words = text(render(state)).replace(/· Watch\b/g, '');
    expect(words).not.toMatch(/handover|hand over|\bshifts?\b|\bwatch|context|compress|readiness|\battempt|\bprobe|evidence|\bsafe\b|certified|guarantee/i);
  });

  it('setup shows who runs it, cost and cap, the checks, the key and the disclaimer', () => {
    const t = text(render('setup'));
    for (const s of ['Sample agent', 'No code, 1 run. Doesn’t test your agent.', 'Your agent', 'Needs a small adapter.', '1 run', '3 runs',
      'Model: claude-haiku-4-5, the one support-bot used most recently · Change', 'Never more than 120 calls, including control checks and memory summaries.',
      'Set ANTHROPIC_API_KEY to the key your agent uses with prod-eu.', 'Right result after its memory fills up', 'Loop breaker · Enforce · 2 extra calls',
      'Spend cap · Enforce · Not checked: it would need real spending.', 'Start test', 'Start from your computer', DISCLAIMER]) expect(t).toContain(s);
    expect(text(render('setup-new-agent'))).toContain('Model your agent uses');
    // A fleet with no agents yet: the sample agent, since Your agent needs one that has called through WhiteRoom.
    const none = renderToStaticMarkup(createElement(PracticeTest, { preview: { ...PRACTICE_STATES.setup, setup: { ...PRACTICE_STATES.setup.setup!, agents: [] } } }));
    expect(text(none)).toContain('Run your agent through WhiteRoom once first, so it shows up here.');
    const radios = none.match(/<input[^>]*name="practice-who"[^>]*>/g) ?? [];
    expect(radios).toHaveLength(2);
    expect(radios[0]).toContain('checked=""');
    expect(radios[1]).toContain('disabled=""');
    expect(text(render('setup-new-agent'))).toContain('Pause and Stop: not checked on this fleet.');
  });

  it('the controls preview lists Pause and Stop on a fleet with no rules, and says so when the controls couldn’t be read', () => {
    const setup = (controls: PracticeControlCheck[] | null) => text(renderToStaticMarkup(createElement(PracticeTest, { preview: { ...PRACTICE_STATES.setup, controls } })));
    const pauseOnly = setup([{ id: 'ctl.pause_stop', label: 'Pause and Stop', mode: null, agents: [], checked: true, note: null, calls: 2 }]);
    expect(pauseOnly).toContain('Pause and Stop');
    expect(pauseOnly).not.toContain('No controls set');
    expect(pauseOnly).not.toContain('Pause and Stop: not checked');
    const unknown = setup(null);
    expect(unknown).toContain('Couldn’t read this fleet’s controls just now.');
    expect(unknown).not.toContain('No controls set');
    expect(unknown).not.toContain('Pause and Stop: not checked');
    expect(setup([])).toContain('No controls set on this fleet yet');
  });

  it('a fleet whose calls go through a proxy URL or a cloud provider, with no Fleet key key to pick, is refused before Start', () => {
    const startButton = (html: string) => html.match(/<button[^>]*>Start test<\/button>/)?.[0] ?? '';
    const blocked = (provider: 'proxy-url' | 'cloud') => renderToStaticMarkup(createElement(PracticeTest, { preview: { ...PRACTICE_STATES['setup-blocked'], provider } }));
    expect(text(blocked('proxy-url'))).toContain('Practice tests don’t support this fleet’s provider yet. Use the connection test instead: Test my agent →');
    expect(text(blocked('cloud'))).toContain('To test an agent that uses Azure OpenAI, Claude on Azure (Foundry) or AWS Bedrock, add its key on Fleet key , then come back and pick it here.');
    expect(blocked('cloud')).toMatch(/<a[^>]*href="\/fleet-key"[^>]*>Fleet key<\/a>/);
    for (const provider of ['proxy-url', 'cloud'] as const) expect(startButton(blocked(provider))).toContain('disabled=""');
    // The sample agent calls the provider itself: a cloud fleet can still run it; a proxy-URL fleet can't.
    const sampleOnly = (provider: 'cloud' | 'proxy-url') => renderToStaticMarkup(createElement(PracticeTest, { preview: { ...PRACTICE_STATES['setup-blocked'], provider, setup: { ...PRACTICE_STATES['setup-blocked'].setup!, agents: [] } } }));
    expect(text(sampleOnly('cloud'))).not.toContain('provider yet');
    expect(startButton(sampleOnly('cloud'))).not.toContain('disabled=""');
    expect(startButton(sampleOnly('proxy-url'))).toContain('disabled=""');
    // Direct keys, or not yet known: Start stays open (its own checks still apply).
    for (const provider of ['direct-anthropic', 'direct-openai', 'unknown', undefined] as const) {
      const html = renderToStaticMarkup(createElement(PracticeTest, { preview: { ...PRACTICE_STATES.setup, provider } }));
      expect(text(html)).not.toContain('provider yet');
      expect(startButton(html)).not.toContain('disabled=""');
    }
  });

  it('the sample agent’s model line names its own models and offers Change', () => {
    const none = renderToStaticMarkup(createElement(PracticeTest, { preview: { ...PRACTICE_STATES.setup, setup: { ...PRACTICE_STATES.setup.setup!, agents: [] } } }));
    expect(text(none)).toContain('Model the sample agent uses: claude-haiku-4-5 with an Anthropic key, gpt-4o-mini with an OpenAI key · Change');
    expect(none).toMatch(/<button type="button"[^>]*>Change<\/button>/);
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
    // Open on another fleet (or another account): said so, with nothing to open or end from here.
    const elsewhere = text(render('refused-open-elsewhere'));
    expect(elsewhere).toContain('You already have a practice test open on another fleet. Finish or end it there, then start this one.');
    expect(elsewhere).not.toMatch(/View it|End it|Continue it|Cancel it/);
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
    expect(failed).toMatch(/Didn't pass · 1 check failed.*What to fix.*Saves once when a tool times out.*Fix: create the key once/);
    expect(failed).toContain('Rerun failed checks');
    const incomplete = text(render('incomplete'));
    expect(incomplete).toMatch(/What stopped the test.*Test problem \(not your agent\): Anthropic hit a rate limit or quota \(HTTP 429\)\./);
    expect(incomplete).toContain('Rerun checks that didn’t run');
    const ended = text(render('ended'));
    expect(ended).toMatch(/Didn’t finish.*What stopped the test.*You ended the test from the dashboard\..*Start a new test/);
    expect(text(render('ended-call-cap'))).toContain('What stopped the test Stopped at this test’s model-call limit after WhiteRoom had to rerun a task (not your agent).');
    expect(text(render('ended-no-model-calls'))).toContain('What stopped the test Stopped: your agent didn’t make any model calls through WhiteRoom');
    expect(text(render('ended-engine-error'))).toMatch(/What stopped the test WhiteRoom couldn’t finish working out the result \(not your agent\)\..*Start a new test/);
    // A crashed adapter still gets a result over the tasks it finished, and says why it ended early.
    expect(text(render('incomplete-adapter-crashed'))).toMatch(/Didn't finish · .*Your adapter stopped with an error, so the test ended early\..*Rerun checks that didn’t run/);
  });

  it('confirms a rerun’s cost and ending a test before acting', () => {
    expect(text(render('confirm-rerun'))).toMatch(/Rerun 1 check × 3 runs · usually \d+–\d+ model calls .*never more than \d+\..*Get run code/);
    const end = render('confirm-end');
    expect(end).toContain('role="alertdialog"');
    expect(text(end)).toMatch(/End this practice test\?.*Finished practice tasks are kept.*Your live agents aren’t affected\./);
  });
});

describe('practice tests on cloud providers (R7)', () => {
  const startButton = (html: string) => html.match(/<button[^>]*>Start test<\/button>/)?.[0] ?? '';

  it('one eligible key is named as text; its provider labels the model field, prefilled, and names the key variable', () => {
    for (const [state, label, keyText, keyLine, modelValue] of [
      ['setup-azure', 'Azure deployment name', 'Key: Azure OpenAI · acme.openai.azure.com · key ending a1b2 · added Oct 3, from Fleet key',
        'Run this where AZURE_OPENAI_API_KEY is set to the same Azure OpenAI key you added on Fleet key (key ending a1b2).', 'support-gpt4o-mini'],
      ['setup-bedrock', 'Bedrock model ID · like anthropic.claude-haiku-4-5', 'Key: AWS Bedrock · us-east-1 · key ending 7c3d · added Oct 3, from Fleet key',
        'Run this where AWS_BEARER_TOKEN_BEDROCK is set to the same AWS Bedrock key you added on Fleet key (key ending 7c3d).', 'anthropic.claude-haiku-4-5'],
      ['setup-foundry', 'Foundry model', 'Key: Claude on Azure (Foundry) · acme.services.ai.azure.com · key ending 5e6f · added Oct 3, from Fleet key',
        'Run this where ANTHROPIC_FOUNDRY_API_KEY is set to the same Claude on Azure (Foundry) key you added on Fleet key (key ending 5e6f).', 'claude-haiku-4-5'],
    ] as const) {
      const html = render(state);
      const t = text(html);
      for (const want of [label, keyText, keyLine]) expect(t, state).toContain(want);
      expect(html).not.toContain('id="practice-key"');
      const input = html.match(/<input id="practice-model"[^>]*>/)?.[0] ?? '';
      expect(input).toContain(`value="${modelValue}"`);
      expect(input).toContain('required=""');
      expect(startButton(html)).not.toContain('disabled=""');
    }
    expect(text(render('setup-azure'))).toContain('Never more than 120 calls, billed by your Azure account. That includes control checks and memory summaries.');
    expect(text(render('setup-foundry'))).toContain('billed by your Azure account');
    expect(text(render('setup-bedrock'))).toMatch(/approx\. \$[\d.]+–\$[\d.]+ at Anthropic’s list prices\)\. Never more than 120 calls, billed by your AWS account/);
  });

  it('a cloud key with no model yet: Start waits for one', () => {
    const html = render('setup-azure-no-model');
    expect(html).toMatch(/<input id="practice-model"[^>]*value=""/);
    expect(startButton(html)).toContain('disabled=""');
    expect(text(html)).toContain('Enter the deployment name to start.');
  });

  it('several keys: a picker in Fleet key’s words, and the keys it can’t use with why', () => {
    const html = render('setup-keys');
    const options = [...html.matchAll(/<option value="(sk-wr-[^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => m[2]);
    expect(options).toEqual([
      'Azure OpenAI · acme.openai.azure.com · key ending a1b2 · added Oct 3', 'AWS Bedrock · us-east-1 · key ending 7c3d · added Oct 3',
      'Claude on Azure (Foundry) · acme.services.ai.azure.com · key ending 5e6f · added Oct 3', 'Anthropic · key ending b5be · added Sep 21',
    ]);
    const t = text(html);
    expect(t).toContain('Fleet key keys a practice test can’t use:');
    expect(t).toContain('AWS Bedrock · us-west-2 · added Oct 3: This key uses WhiteRoom\'s own cloud access, so there\'s no key of yours to test with. Add a provider key on Fleet key, then pick it.');
    expect(t).toContain('OpenAI · api.groq.com · key ending 117d · added Oct 3: This key sends its calls to a host other than its provider\'s own. Practice tests don\'t support that.');
  });

  it('a proxy URL fleet with an Anthropic key on Fleet key can now run; one with only unusable keys says why', () => {
    const html = render('setup-proxy-url');
    expect(text(html)).toContain('Run this where ANTHROPIC_API_KEY is set to the same Anthropic key you added on Fleet key (key ending b5be).');
    expect(text(html)).not.toContain('provider yet');
    expect(startButton(html)).not.toContain('disabled=""');
    const none = render('setup-no-cloud-key');
    expect(text(none)).toContain('add its key on Fleet key');
    expect(text(none)).toContain('Fleet key keys a practice test can’t use:');
    expect(startButton(none)).toContain('disabled=""');
  });

  it('a fleet on a Bedrock IAM role is refused for both agents, in the catalog’s words', () => {
    const html = render('setup-bedrock-role');
    expect(text(html)).toContain('This fleet reaches AWS Bedrock through an IAM role, which practice tests don\'t support. Use the connection test instead: Test my agent →');
    expect(startButton(html)).toContain('disabled=""');
    const sample = renderToStaticMarkup(createElement(PracticeTest, { preview: { ...PRACTICE_STATES['setup-bedrock-role'], setup: { ...PRACTICE_STATES['setup-bedrock-role'].setup!, agents: [] } } }));
    expect(startButton(sample)).toContain('disabled=""');
  });

  it('Start’s key refusals say what to do next', () => {
    expect(text(render('refused-key-gone'))).toContain('That key isn\'t on Fleet key any more. Pick another key. Open Fleet key →');
    expect(text(render('refused-engine-access'))).toContain('Open Fleet key →');
    expect(text(render('refused-other-host'))).toContain('Use the connection test instead: Test my agent →');
    expect(text(render('refused-model'))).toContain('Enter the model your agent uses: the deployment name on Azure');
  });

  it('the terminal steps name the key variable and Fleet key key for each provider', () => {
    expect(text(render('code-azure'))).toContain('Needs Node 20 or later. Run this where AZURE_OPENAI_API_KEY is set to the same Azure OpenAI key you added on Fleet key (key ending a1b2). Keep');
    // From the run's own fields, so any tab names the key; the command picks its variable, so other keys set on the computer don't matter.
    expect(text(render('code-azure'))).toContain('whiteroom practice run --adapter "node wr-adapter.mjs" --key-env AZURE_OPENAI_API_KEY');
    expect(text(render('code'))).not.toContain('--key-env');
    expect(text(render('code-bedrock'))).toContain('AWS_BEARER_TOKEN_BEDROCK is set to the same AWS Bedrock key you added on Fleet key (key ending 7c3d)');
    expect(text(render('code-foundry'))).toContain('ANTHROPIC_FOUNDRY_API_KEY is set to the same Claude on Azure (Foundry) key you added on Fleet key (key ending 5e6f)');
    expect(text(render('code'))).toContain('Set ANTHROPIC_API_KEY or OPENAI_API_KEY to the key your agent uses with prod-eu.');
  });

  it('results say which provider was tested, and a provider refusal names it', () => {
    expect(text(render('passed-azure'))).toContain('Provider Azure OpenAI (the key you picked from Fleet key, ending a1b2)');
    expect(text(render('passed'))).toContain('Provider Anthropic Adapter');
    expect(text(render('incomplete-bedrock'))).toContain('Test problem (not your agent): AWS Bedrock hit a rate limit or quota (HTTP 429).');
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
    expect(t).toMatch(/Passed 18\/18 Practice/);
    expect(t).toMatch(/Rerun · passed \(1 check\) 3\/3 Practice/);
    expect(t).toMatch(/Didn't finish 2\/6 Practice \(sample\)/);
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

  it('a cloud connection test that passed points to practice tests too (R7)', () => {
    const cloud = { sandboxId: 'p', mode: 'connected' as const, expiresInSeconds: 900, agents: [], provider: 'azure-openai', endpointHost: 'acme.openai.azure.com',
      controls: ['core.connect', 'core.handoff', 'core.resume'].map((controlId) => ({ controlId, name: controlId, result: { liveEvidence: { status: 'observed' } } })) } as unknown as RunStatusResult;
    const flow = (practice: PracticeEntry) => text(renderToStaticMarkup(createElement(TestRunFlow as FC<NonNullable<Parameters<typeof TestRunFlow>[0]>>, { previewUserId: 'u', previewRun: cloud, previewPractice: practice })));
    const line = 'Want more confidence before going live? Run a practice test : 5 practice tasks plus a check of your controls, about 30 minutes.';
    const without = flow({ fleet: null, rows: null, open: null });
    expect(without).toContain('Ready to go live');
    const withLine = flow({ fleet: 'prod-eu', rows: [], open: null });
    expect(withLine).toContain(line);
    expect(withLine.replace(` ${line}`, '')).toBe(without);
  });
});
