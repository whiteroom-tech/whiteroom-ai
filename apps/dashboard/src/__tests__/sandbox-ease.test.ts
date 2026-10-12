// Sandbox ease of use: the no-code setup says only what works, the workspace
// tabs are a real tablist, the demo reveals its checks one step at a time,
// detail text stays readable, status changes send the right analytics (with
// nothing identifying) and open help or results when they should.

import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { RunStatusResult } from '@/lib/sandbox/api';

vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null, status: 'unauthenticated' }) }));
vi.mock('@/lib/analytics', () => ({ analytics: { capture: () => {} } }));

const { checkGuidance, hasNoCalls, IDLE_HELP_AFTER_MS, idleHelpDelay, runSnapshot, runTransition, testEndedEvent, testStartedEvent, WorkspacePanel, WorkspaceTabs } = await import('@/components/sandbox/TestRunFlow');
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

describe('readable text', () => {
  it('keeps Sandbox text at 12px or more, apart from mono labels and badges', () => {
    const css = read('../components/sandbox/guided.module.css');
    const small = [...css.matchAll(/^(\.[\w]+)[^{]*\{[^}]*font-size:\s*([\d.]+)px/gm)].filter((m) => Number(m[2]) < 12).map((m) => m[1]);
    expect(small.sort()).toEqual(['.badgeMode', '.diagDot', '.eyebrow', '.previewHeader']);
    const inline = [...read('../components/sandbox/TestRunFlow.tsx').matchAll(/fontSize: ([\d.]+)/g)].map((m) => Number(m[1]));
    expect(inline.every((n) => n >= 12)).toBe(true);
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
    clean([first, done]);
  });

  it('counts nothing for a test first seen already finished, another test, or a demo', () => {
    expect(runTransition(null, snap({ ...called, controls: observed(3) }))).toEqual({ events: [], showResults: false });
    expect(runTransition(snap(), runSnapshot(live({ ...called, sandboxId: 'other' }), 'anthropic')).events).toEqual([]);
    expect(runSnapshot(live({ mode: 'demo' }), 'anthropic')).toBeNull();
  });

  it('opens Checks when a live test expires', () => {
    expect(runTransition(snap(called), snap({ ...called, expiresInSeconds: 0 }))).toEqual({ events: [], showResults: true });
  });

  it('describes starting and ending a test by mode, provider and a check count only', () => {
    expect(testStartedEvent('connected', 'bedrock-mantle')).toEqual({ name: 'sandbox_test_started', props: { mode: 'connected', provider: 'bedrock-mantle' } });
    expect(testStartedEvent('demo', 'anthropic')).toEqual({ name: 'sandbox_test_started', props: { mode: 'demo', provider: undefined } });
    const ended = testEndedEvent(live({ ...called, controls: observed(2) }));
    expect(ended).toEqual({ name: 'sandbox_test_ended', props: { mode: 'connected', checks_passed: 2 } });
    clean(ended);
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
