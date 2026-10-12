// Sandbox ease of use: the no-code setup says only what works, the workspace
// tabs are a real tablist, the demo reveals its checks one step at a time,
// detail text stays readable, status changes send the right analytics (with
// nothing identifying) and open help or results when they should.

import { describe, expect, it, vi } from 'vitest';
import { createElement, type FC } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { RunStatusResult } from '@/lib/sandbox/api';

vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null, status: 'unauthenticated' }) }));
vi.mock('@/lib/analytics', () => ({ analytics: { capture: () => {} } }));

const { allChecksPassed, CheckPreview, checkGuidance, checksPassedCount, hasNoCalls, helpReducer, IDLE_HELP_AFTER_MS, idleHelpDelay, isObserved, runSnapshot, runTransition, testStartedEvent, TestRunFlow, WorkspacePanel, WorkspaceTabs } = await import('@/components/sandbox/TestRunFlow');
const { PastTestDetail, PastTests } = await import('@/components/sandbox/PastTests');
const { MIN_TEXT_PX, SMALL_LABEL_CLASSES } = await import('@/components/sandbox/type-scale');
const { noCodeSetup } = await import('@/lib/sandbox/providers');

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const opts = { proxyUrl: 'https://proxy.whiteroom.tech/', base: 'https://proxy.whiteroom.tech/sk-wr-test', fleetId: 'sandbox-1234' };

describe('No code change', () => {
  it('offers nothing to copy for an OpenAI test, and says why', () => {
    const setup = noCodeSetup('openai', opts);
    expect(setup.code).toBeNull();
    expect(setup.lead).toContain('x-whiteroom-fleet');
    expect(setup.lead).toContain('Python or JavaScript');
  });

  it('gives Claude Code the fleet header for an Anthropic test', () => {
    const setup = noCodeSetup('anthropic', opts);
    expect(setup.lead).toContain('most agents need the Python or JavaScript setup');
    expect(setup.code).toContain('export ANTHROPIC_BASE_URL=https://proxy.whiteroom.tech\n');
    expect(setup.code).toContain('export ANTHROPIC_CUSTOM_HEADERS="x-whiteroom-fleet: sandbox-1234"');
  });

  it('uses the proxy URL for cloud tests, and names the header unnamed agents need', () => {
    expect(noCodeSetup('azure-openai', opts).code).toContain('export AZURE_OPENAI_ENDPOINT=https://proxy.whiteroom.tech/sk-wr-test');
    expect(noCodeSetup('bedrock-mantle', opts).code).toContain('export ANTHROPIC_API_KEY="$AWS_BEARER_TOKEN_BEDROCK"');
    expect(noCodeSetup('foundry', opts).code).toContain('export ANTHROPIC_API_KEY="$ANTHROPIC_FOUNDRY_API_KEY"');
    for (const p of ['azure-openai', 'foundry', 'bedrock-mantle'] as const) {
      expect(noCodeSetup(p, opts).code).toContain(opts.base);
      expect(noCodeSetup(p, opts).note).toContain('x-whiteroom-agent');
    }
  });
});

describe('workspace tabs', () => {
  it('is a tablist with one tab stop', () => {
    const html = renderToStaticMarkup(createElement(WorkspaceTabs, { value: 'results', onChange: () => {} }));
    expect(html).toContain('role="tablist"');
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html).toMatch(/id="sandbox-tab-results" aria-selected="true" aria-controls="sandbox-panel-results" tabindex="0"/);
    expect(html).toMatch(/id="sandbox-tab-setup" aria-selected="false" aria-controls="sandbox-panel-setup" tabindex="-1"/);
  });

  it('renders panels linked back to their tabs, hiding the inactive ones', () => {
    for (const tab of ['setup', 'results', 'activity'] as const) {
      const on = renderToStaticMarkup(createElement(WorkspacePanel, { tab, active: true, children: 'x' }));
      expect(on).toMatch(new RegExp(`role="tabpanel" id="sandbox-panel-${tab}" aria-labelledby="sandbox-tab-${tab}" tabindex="0"`));
      expect(on).not.toContain('hidden');
      expect(renderToStaticMarkup(createElement(WorkspacePanel, { tab, active: false, children: 'x' }))).toContain('hidden=""');
    }
  });
});

describe('demo walkthrough', () => {
  it('names the step that reveals a check', () => {
    expect(checkGuidance('core.handoff', 'unrevealed', { mode: 'demo' }, 'anthropic').detail).toBe('Shown in step 2 of the walkthrough.');
    expect(checkGuidance('core.resume', 'unrevealed', { mode: 'demo' }, 'anthropic').detail).toBe('Shown in step 3 of the walkthrough.');
  });
});

// A live test as status reads report it. The secrets and names in it must
// never reach an analytics event.
const SECRETS = ['sk-ant-secret', 'acme.openai.azure.com', 'sandbox-live-1', 'live-1', 'support-bot'];
const live = (o: Partial<RunStatusResult> = {}): RunStatusResult => ({
  sandboxId: 'live-1', mode: 'connected', expiresInSeconds: 1500, endpointHost: 'acme.openai.azure.com',
  agents: [{ agentId: 'support-bot', role: 'worker', status: 'active', watchMinutes: 2, watchCount: 0, totalTasks: 0, totalTokens: 0, pairedWith: null, currentWatch: null }],
  controls: ['core.connect', 'core.handoff', 'core.resume'].map((controlId) => ({ controlId, name: controlId, result: {} })) as unknown as RunStatusResult['controls'],
  auditLog: [], ...o, ...({ apiKey: 'sk-ant-secret' } as object),
});
const observed = (n: number) => ['core.connect', 'core.handoff', 'core.resume'].map((controlId, i) => ({ controlId, name: controlId, result: i < n ? { liveEvidence: { status: 'observed', timestamp: '2026-10-12T10:00:00Z' } } : {} })) as unknown as RunStatusResult['controls'];
const called = { auditLog: [{ id: 'r', timestamp: '2026-10-12T10:00:00Z', type: 'register', agentId: 'support-bot' }], controls: observed(1) };
const snap = (o: Partial<RunStatusResult> = {}) => runSnapshot(live(o), 'azure-openai');
const clean = (events: unknown) => { const json = JSON.stringify(events); for (const x of SECRETS) expect(json).not.toContain(x); };

describe('Sandbox analytics and status changes', () => {
  it('sends first call and checks passed once, on the rising edge', () => {
    const first = runTransition(snap(), snap(called));
    expect(first.events).toEqual([{ name: 'sandbox_first_call', props: { provider: 'azure-openai' } }]);
    expect(first.showResults).toBe(false);
    expect(runTransition(snap(called), snap(called)).events).toEqual([]);
    const done = runTransition(snap(called), snap({ ...called, controls: observed(3) }));
    expect(done.events).toEqual([{ name: 'sandbox_checks_passed', props: { provider: 'azure-openai' } }]);
    expect(done.showResults).toBe(true);
    clean([first.events, done.events]);
  });

  it('counts nothing for a test first seen already finished, or a different test', () => {
    expect(runTransition(null, snap({ ...called, controls: observed(3) }))).toMatchObject({ events: [], showResults: false });
    expect(runTransition(snap(), runSnapshot(live({ ...called, sandboxId: 'other' }), 'anthropic')).events).toEqual([]);
  });

  it('never sends first call or checks passed for a demo, nor opens Checks for it', () => {
    const demo = (o: Partial<RunStatusResult>) => runSnapshot(live({ mode: 'demo', ...o }), 'anthropic');
    const demoPassed = ['core.connect', 'core.handoff', 'core.resume'].map((controlId) => ({ controlId, name: controlId, result: { demoEvidence: { status: 'observed', timestamp: '2026-10-12T10:00:00Z' } } })) as unknown as RunStatusResult['controls'];
    expect(runTransition(demo({}), demo({ ...called, controls: demoPassed }))).toMatchObject({ events: [], showResults: false });
  });

  it('sends test ended once when the test expires, and opens Checks', () => {
    const expired = runTransition(snap(called), snap({ ...called, expiresInSeconds: 0 }));
    expect(expired.events).toEqual([{ name: 'sandbox_test_ended', props: { mode: 'connected', checks_passed: 1, ended_by: 'expired' } }]);
    expect(expired.showResults).toBe(true);
    // Read again, then ended by the user: already counted.
    const again = runTransition(expired.keep, snap({ ...called, expiresInSeconds: 0 }));
    expect(again.events).toEqual([]);
    expect(runTransition(again.keep, null, 'user').events).toEqual([]);
    clean(expired.events);
  });

  it('sends test ended when the user ends it or it is gone, with why', () => {
    expect(runTransition(snap(called), null, 'user').events).toEqual([{ name: 'sandbox_test_ended', props: { mode: 'connected', checks_passed: 1, ended_by: 'user' } }]);
    expect(runTransition(snap(), null, 'other').events).toEqual([{ name: 'sandbox_test_ended', props: { mode: 'connected', checks_passed: 0, ended_by: 'other' } }]);
    expect(runTransition(runSnapshot(live({ mode: 'demo' }), 'anthropic'), null, 'user').events).toEqual([{ name: 'sandbox_test_ended', props: { mode: 'demo', checks_passed: 0, ended_by: 'user' } }]);
    // Gone for no known reason (another account signed in): nothing.
    expect(runTransition(snap(called), null).events).toEqual([]);
    expect(runTransition(null, null, 'user').events).toEqual([]);
  });

  it('describes a start by mode and provider only', () => {
    expect(testStartedEvent('connected', 'bedrock-mantle')).toEqual({ name: 'sandbox_test_started', props: { mode: 'connected', provider: 'bedrock-mantle' } });
    expect(testStartedEvent('demo', 'anthropic')).toEqual({ name: 'sandbox_test_started', props: { mode: 'demo', provider: undefined } });
  });

  it('reads demo evidence in a demo and live evidence otherwise', () => {
    const run = live({ controls: observed(2) });
    expect(checksPassedCount(run)).toBe(2);
    expect(checksPassedCount({ ...run, mode: 'demo' })).toBe(0);
    expect(isObserved(run, run.controls![0])).toBe(true);
    expect(allChecksPassed(live({ controls: observed(3) }))).toBe(true);
    expect(allChecksPassed(live({ controls: [] }))).toBe(false);
  });
});

describe('Nothing happening?', () => {
  const t0 = 1_000_000;
  it('opens a minute after the page first saw a live test with no calls', () => {
    expect(idleHelpDelay({ run: live(), firstSeenAt: t0, now: t0 + 10_000, autoOpenedFor: null })).toBe(IDLE_HELP_AFTER_MS - 10_000);
    expect(idleHelpDelay({ run: live(), firstSeenAt: t0, now: t0 + 120_000, autoOpenedFor: null })).toBe(0);
  });

  it('does not depend on how long the test lasts', () => {
    // A 10-minute test, just started: still a minute to go.
    expect(idleHelpDelay({ run: live({ expiresInSeconds: 600 }), firstSeenAt: t0, now: t0, autoOpenedFor: null })).toBe(IDLE_HELP_AFTER_MS);
  });

  it('stays shut once opened, after any call, in a demo, or once the test ended', () => {
    const base = { firstSeenAt: t0, now: t0 + 120_000, autoOpenedFor: null };
    expect(idleHelpDelay({ ...base, run: live(), autoOpenedFor: 'live-1' })).toBeNull();
    expect(idleHelpDelay({ ...base, run: live(called) })).toBeNull();
    expect(idleHelpDelay({ ...base, run: live({ failedCalls: { count: 1, last: { at: '', agentId: 'a', status: 401, reason: 'upstream_error', message: '' } } }) })).toBeNull();
    expect(idleHelpDelay({ ...base, run: live({ mode: 'demo' }) })).toBeNull();
    expect(idleHelpDelay({ ...base, run: live({ expiresInSeconds: 0 }) })).toBeNull();
    expect(hasNoCalls(live())).toBe(true);
  });
});

describe('Nothing happening? per test', () => {
  const closed = { testId: null, open: false, autoOpenedFor: null };
  it('starts closed for a new test, even if it was open for the last one', () => {
    let st = helpReducer(closed, { type: 'test', id: 'a' });
    st = helpReducer(st, { type: 'autoOpen', id: 'a' });
    expect(st).toEqual({ testId: 'a', open: true, autoOpenedFor: 'a' });
    st = helpReducer(st, { type: 'test', id: 'b' });
    expect(st).toEqual({ testId: 'b', open: false, autoOpenedFor: null });
    // And can open itself once for that test.
    expect(helpReducer(st, { type: 'autoOpen', id: 'b' }).open).toBe(true);
  });

  it('opens itself once per test and leaves the user’s choice alone', () => {
    let st = helpReducer(helpReducer(closed, { type: 'test', id: 'a' }), { type: 'autoOpen', id: 'a' });
    st = helpReducer(st, { type: 'toggle', open: false });
    expect(helpReducer(st, { type: 'autoOpen', id: 'a' }).open).toBe(false);
    expect(helpReducer(st, { type: 'test', id: 'a' })).toBe(st);
    // A late timer for a test that's gone does nothing.
    expect(helpReducer(helpReducer(closed, { type: 'test', id: 'b' }), { type: 'autoOpen', id: 'a' }).open).toBe(false);
  });
});

/** Every rule in a stylesheet, nested @media included, with its selectors split. */
function cssRules(css: string): { selectors: string[]; body: string }[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: { selectors: string[]; body: string }[] = [];
  let i = 0;
  const block = (): void => {
    while (i < src.length) {
      const open = src.indexOf('{', i);
      const close = src.indexOf('}', i);
      if (close !== -1 && (open === -1 || close < open)) { i = close + 1; return; }
      if (open === -1) { i = src.length; return; }
      const prelude = src.slice(i, open).trim();
      i = open + 1;
      if (prelude.startsWith('@')) { block(); continue; }
      const end = src.indexOf('}', i);
      rules.push({ selectors: prelude.split(',').map((x) => x.trim()).filter(Boolean), body: src.slice(i, end) });
      i = end + 1;
    }
  };
  block();
  return rules;
}

const SMALL_PX = (html: string) => [...html.matchAll(/font-size:\s*([\d.]+)px/g)].map((m) => Number(m[1])).filter((n) => n < MIN_TEXT_PX);

describe('readable text', () => {
  it('parses comma selectors, multi-line rules and @media blocks', () => {
    const rules = cssRules('/* x */ .a,\n.b .c { font-size: 10px;\n color: red }\n@media (max-width:1px) { .d { font-size: 9px } }');
    expect(rules).toEqual([{ selectors: ['.a', '.b .c'], body: ' font-size: 10px;\n color: red ' }, { selectors: ['.d'], body: ' font-size: 9px ' }]);
  });

  it('keeps guided.module.css at 12px or more, apart from the small labels', () => {
    const small = new Set<string>();
    for (const r of cssRules(read('../components/sandbox/guided.module.css'))) {
      const px = /font-size:\s*([\d.]+)px/.exec(r.body);
      if (!px || Number(px[1]) >= MIN_TEXT_PX) continue;
      for (const sel of r.selectors) {
        const subject = [...sel.matchAll(/\.([\w-]+)/g)].at(-1)?.[1] ?? sel;
        expect(SMALL_LABEL_CLASSES).toContain(subject);
        small.add(subject);
      }
    }
    // The allow-list stays as small as the stylesheet needs.
    expect([...small].sort()).toEqual([...SMALL_LABEL_CLASSES].sort());
  });

  it('renders no inline text below 12px in the Sandbox', () => {
    const user = { previewUserId: 'u', previewPastTests: [] };
    const demoPassed = ['core.connect', 'core.handoff', 'core.resume'].map((controlId) => ({ controlId, name: controlId, result: { demoEvidence: { status: 'observed', timestamp: '2026-10-12T10:00:00Z' } } })) as unknown as RunStatusResult['controls'];
    const runs: RunStatusResult[] = [
      live(),
      live({ ...called, controls: observed(3), agents: live().agents!.map((a) => ({ ...a, totalTasks: 3 })) }),
      live({ provider: 'azure-openai', failedCalls: { count: 2, last: { at: '', agentId: 'support-bot', status: 401, reason: 'upstream_error', message: 'denied' } } }),
      live({ mode: 'demo', controls: demoPassed, ...{ auditLog: called.auditLog } }),
      live({ expiresInSeconds: 0 }),
    ];
    for (const previewRun of runs) {
      const html = renderToStaticMarkup(createElement(TestRunFlow as FC<NonNullable<Parameters<typeof TestRunFlow>[0]>>, { ...user, previewRun }));
      expect(html).toContain('role="tablist"');
      expect(SMALL_PX(html)).toEqual([]);
    }
    const past = [{ sandboxId: 's1', destroyedAt: '2026-10-12T10:00:00Z', overall: 'pass' as const, totalTasks: 3, isTrial: false }];
    for (const el of [createElement(CheckPreview), createElement(PastTests, { preview: past }), createElement(PastTests, { preview: [] }), createElement(PastTestDetail, { test: past[0], onClose: () => {} })]) {
      expect(SMALL_PX(renderToStaticMarkup(el))).toEqual([]);
    }
  });
});
