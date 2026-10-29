// Keys made for one agent (engine #311): the key list says which agent, and
// both Stop confirmations explain how a shared key lets a stopped agent go on.
// Rendered statically, like the other component tests here.
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { KeyScopeNote, StopNotes } from '@/components/citadel/StopNotes';
import { SHARED_KEY_STOP_NOTE, UNNAMED_CALLS_REFUSED } from '@/lib/setup';

describe('keys for one agent', () => {
  it('a key made for one agent shows "only for <agent>"; a fleet-wide key shows nothing', () => {
    expect(renderToStaticMarkup(h(KeyScopeNote, { agentId: 'claims-triage' }))).toMatch(/only for (<!-- -->)?claims-triage/);
    expect(renderToStaticMarkup(h(KeyScopeNote, {}))).toBe('');
  });

  it('the Stop confirmation notes say unnamed calls are refused and how to make Stop stick', () => {
    const html = renderToStaticMarkup(h(StopNotes));
    expect(html).toContain(UNNAMED_CALLS_REFUSED);
    expect(html).toContain(SHARED_KEY_STOP_NOTE);
    expect(SHARED_KEY_STOP_NOTE).toContain('Fleet key page');
  });
});
