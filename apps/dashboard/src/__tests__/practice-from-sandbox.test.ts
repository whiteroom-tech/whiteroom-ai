// @vitest-environment happy-dom
// A practice test opened from the Sandbox's report: Start sends origin
// "sandbox" for the report's agent, quick, with no key from Fleet key; only
// your own agent is offered, and Start waits for a profile.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { PracticeSetup } from '@/components/sandbox/practice/PracticeSetup';
import { PRACTICE_STATES } from '@/app/dev/practice/states';

afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals(); });

describe('a practice test from the Sandbox', () => {
  it('Start sends the agent, quick and origin sandbox, and no key from Fleet key', async () => {
    const started: unknown[] = [];
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => {
      root.render(createElement(PracticeSetup, {
        fleet: 'prod-eu', data: { agents: ['sbx-agent'] }, busy: false, sandboxAgent: 'sbx-agent',
        previewCapabilities: PRACTICE_STATES['setup-from-sandbox'].capabilities,
        preview: { model: null, provider: 'unknown', directKey: false, blocked: null, providerKeys: [], controls: null },
        onStart: (st) => { started.push(st); },
      }));
    });
    await act(async () => { [...el.querySelectorAll('button')].find((b) => b.textContent === 'Start test')!.click(); });
    expect(started).toEqual([expect.objectContaining({ agent: 'sbx-agent', sample: false, profile: 'quick', origin: 'sandbox' })]);
    expect(started[0]).not.toHaveProperty('proxyKeyDisplayPrefix');
    // Only your own agent: the sample agent's run would fill this agent's report.
    expect(el.textContent).not.toContain('Test my guardrails');
    // Deep: the Sandbox's rules, not production's controls.
    await act(async () => { [...el.querySelectorAll('button')].find((b) => b.textContent === 'Deep · longer')!.click(); });
    expect(el.textContent).toContain('Your Sandbox rules');
    act(() => root.unmount());
  });

  it('capabilities that couldn’t be read: Start stays off, and Try again asks again', async () => {
    const asks: string[] = [];
    let ok = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/capabilities')) { asks.push(String(url)); return ok ? Response.json({ profiles: ['quick', 'deep'] }) : Response.json({ error: 'down' }, { status: 503 }); }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }));
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => {
      root.render(createElement(PracticeSetup, {
        fleet: 'prod-eu', data: { agents: ['sbx-agent'] }, busy: false, sandboxAgent: 'sbx-agent',
        preview: { model: null, provider: 'unknown', directKey: false, blocked: null, providerKeys: [], controls: null },
        onStart: () => {},
      }));
    });
    await act(async () => { await Promise.resolve(); });
    const start = () => [...el.querySelectorAll('button')].find((b) => b.textContent === 'Start test')!;
    expect(start().disabled).toBe(true);
    expect(el.textContent).toContain('Couldn’t reach practice tests just now.');
    ok = true;
    // While asking again: no "aren't available yet", Start still off.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => { await gate; return realFetch(url, init); }));
    await act(async () => { [...el.querySelectorAll('button')].find((b) => b.textContent === 'Try again')!.click(); });
    expect(el.textContent).not.toContain('aren’t available yet');
    expect(start().disabled).toBe(true);
    release();
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    expect(asks).toHaveLength(2);
    expect(start().disabled).toBe(false);
    expect(el.textContent).not.toContain('Couldn’t reach practice tests');
    act(() => root.unmount());
  });

  it('an engine without profiles: Start stays off, and says why', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => {
      root.render(createElement(PracticeSetup, {
        fleet: 'prod-eu', data: { agents: ['sbx-agent'] }, busy: false, sandboxAgent: 'sbx-agent', previewCapabilities: null,
        preview: { model: null, provider: 'unknown', directKey: false, blocked: null, providerKeys: [], controls: null },
        onStart: () => {},
      }));
    });
    expect([...el.querySelectorAll('button')].find((b) => b.textContent === 'Start test')!.disabled).toBe(true);
    expect(el.textContent).toContain('Practice tests from your Sandbox aren’t available yet.');
    act(() => root.unmount());
  });
});
