// Sandbox ease of use: the no-code setup says only what works, the workspace
// tabs are a real tablist, the demo reveals its checks one step at a time,
// detail text stays readable, and analytics carry nothing identifying.

import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null, status: 'unauthenticated' }) }));
vi.mock('@/lib/analytics', () => ({ analytics: { capture: () => {} } }));

const { checkGuidance, WorkspaceTabs } = await import('@/components/sandbox/TestRunFlow');
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
  it('is a tablist with one tab stop and linked panels', () => {
    const html = renderToStaticMarkup(createElement(WorkspaceTabs, { value: 'results', onChange: () => {} }));
    expect(html).toContain('role="tablist"');
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html).toMatch(/id="sandbox-tab-results" aria-selected="true" aria-controls="sandbox-panel-results" tabindex="0"/);
    expect(html).toMatch(/id="sandbox-tab-setup" aria-selected="false" aria-controls="sandbox-panel-setup" tabindex="-1"/);
    const flow = read('../components/sandbox/TestRunFlow.tsx');
    for (const t of ['setup', 'results', 'activity']) expect(flow).toContain(`role="tabpanel" id="sandbox-panel-${t}" aria-labelledby="sandbox-tab-${t}"`);
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

describe('Sandbox analytics', () => {
  it('sends the five events with mode, provider and a check count only', () => {
    const flow = read('../components/sandbox/TestRunFlow.tsx');
    const calls = [...flow.matchAll(/track\('(\w+)'(?:, \{([^}]*)\})?\)/g)];
    expect(new Set(calls.map((m) => m[1]))).toEqual(new Set(['sandbox_opened', 'sandbox_test_started', 'sandbox_first_call', 'sandbox_checks_passed', 'sandbox_test_ended']));
    for (const m of calls) {
      const keys = (m[2] ?? '').split(',').map((p) => p.split(':')[0].trim()).filter(Boolean);
      for (const k of keys) expect(['mode', 'provider', 'checks_passed']).toContain(k);
    }
  });
});
