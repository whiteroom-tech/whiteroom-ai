// @vitest-environment happy-dom
// A practice test opened from the Sandbox's report (eight checks C3): Start
// sends origin "sandbox" for the report's agent, quick, with no key from Fleet key.
import { afterEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { PracticeSetup } from '@/components/sandbox/practice/PracticeSetup';
import { PRACTICE_STATES } from '@/app/dev/practice/states';

afterEach(() => { document.body.innerHTML = ''; });

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
    act(() => root.unmount());
  });
});
