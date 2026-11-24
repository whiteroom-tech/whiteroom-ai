// Agent page › Contact (gap-closing spec A5): who sees it, what it offers,
// and what a save sends. Rendered statically, like the other component tests.
import { describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/lib/agent-contact-actions', () => ({ agentContactView: vi.fn(), setAgentContact: vi.fn() }));

import { ContactPanelView, saveContactChoice } from '@/components/identity/AgentContactPanel';

const people = [
  { userId: 'owner', email: 'owner@example.com', name: 'Owner' },
  { userId: 'mate', email: 'mate@example.com', name: 'Mate' },
];
const view = { ok: true as const, contact: null, candidates: people };

describe('Contact panel', () => {
  it('shows nothing to a non-owner or before it loads', () => {
    expect(renderToStaticMarkup(h(ContactPanelView, { view: null, saving: false, note: null, onChange: () => {} }))).toBe('');
    expect(renderToStaticMarkup(h(ContactPanelView, { view: { ok: false, error: 'Only the owner.' }, saving: false, note: null, onChange: () => {} }))).toBe('');
  });

  it('offers the owner first, then members by name and email, with the owner chosen by default', () => {
    const html = renderToStaticMarkup(h(ContactPanelView, { view, saving: false, note: null, onChange: () => {} }));
    expect(html).toMatch(/<option value="owner" selected="">You, the owner<\/option><option value="mate">Mate \(mate@example.com\)<\/option>/);
    expect(html).toContain('The person to contact about this agent. It gives no extra access.');
  });

  it('shows the chosen contact and a failed save’s reason', () => {
    const html = renderToStaticMarkup(h(ContactPanelView, { view: { ...view, contact: people[1] }, saving: false, note: { ok: false, text: 'Only the owner.' }, onChange: () => {} }));
    expect(html).toContain('<option value="mate" selected="">');
    expect(html).toContain('Only the owner.');
  });
});

describe('saving a contact', () => {
  it('stores the owner as no contact, and shows what was read back', async () => {
    const set = vi.fn(async () => ({ ok: true as const }));
    const read = vi.fn(async () => ({ ...view, contact: people[1] }));
    expect((await saveContactChoice('f1', 'a1', 'owner', view, { set, read })).note).toEqual({ ok: true, text: 'Saved.' });
    expect(set).toHaveBeenLastCalledWith('f1', 'a1', null);
    const got = await saveContactChoice('f1', 'a1', 'mate', view, { set, read });
    expect(set).toHaveBeenLastCalledWith('f1', 'a1', 'mate');
    expect(got.view).toMatchObject({ contact: { userId: 'mate' } });
  });

  it('keeps the view and says why when the save is refused or throws', async () => {
    const read = vi.fn();
    const refused = await saveContactChoice('f1', 'a1', 'mate', view, { set: async () => ({ ok: false, error: 'Only the owner.' }), read });
    expect(refused).toEqual({ view, note: { ok: false, text: 'Only the owner.' } });
    const thrown = await saveContactChoice('f1', 'a1', 'mate', view, { set: async () => { throw new Error('net'); }, read });
    expect(thrown.note).toEqual({ ok: false, text: 'Couldn’t save. Try again.' });
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps the old view when the read back fails', async () => {
    const got = await saveContactChoice('f1', 'a1', 'mate', view, { set: async () => ({ ok: true }), read: async () => { throw new Error('net'); } });
    expect(got).toEqual({ view, note: { ok: true, text: 'Saved.' } });
  });
});
