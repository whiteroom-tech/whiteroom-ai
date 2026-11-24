'use client';

import { useEffect, useRef, useState } from 'react';
import { Panel } from '@whiteroom/ui';
import { agentContactView, setAgentContact, type ContactView } from '@/lib/agent-contact-actions';

type Note = { ok: boolean; text: string };

/**
 * Saves a choice and reads the contact back. The owner is the default, so
 * picking them clears the contact (null). Returns the view to show (the old
 * one if the read back fails) and the note.
 */
export async function saveContactChoice(
  fleetId: string, agentId: string, userId: string, view: Extract<ContactView, { ok: true }>,
  deps: { set: typeof setAgentContact; read: typeof agentContactView } = { set: setAgentContact, read: agentContactView },
): Promise<{ view: ContactView; note: Note }> {
  const ownerId = view.candidates[0]?.userId;
  const res = await deps.set(fleetId, agentId, userId === ownerId ? null : userId).catch(() => ({ ok: false as const, error: 'Couldn’t save. Try again.' }));
  if (!res.ok) return { view, note: { ok: false, text: res.error } };
  const next = await deps.read(fleetId, agentId).catch(() => null);
  return { view: next?.ok ? next : view, note: { ok: true, text: 'Saved.' } };
}

/** The panel for a loaded view: nothing unless the viewer owns the fleet. */
export function ContactPanelView({ view, saving, note, onChange }: { view: ContactView | null; saving: boolean; note: Note | null; onChange: (userId: string) => void }) {
  if (!view?.ok) return null;
  const [owner, ...members] = view.candidates;
  if (!owner) return null;
  const label = (p: { email: string | null; name: string | null; userId: string }) => (p.name ? `${p.name}${p.email ? ` (${p.email})` : ''}` : p.email ?? p.userId);
  return (
    <Panel title="Contact">
      <p className="wr-agent-cap" style={{ margin: '0 0 6px' }}>
        {note ? <span role="status" style={{ color: note.ok ? 'var(--ok)' : 'var(--bad)' }}>{note.text}</span> : 'The person to contact about this agent. It gives no extra access.'}
      </p>
      <span className="wr-select" style={{ display: 'block' }}>
        <select aria-label="Contact" disabled={saving} value={view.contact?.userId ?? owner.userId} onChange={(e) => onChange(e.target.value)}>
          <option value={owner.userId}>You, the owner</option>
          {members.map((m) => <option key={m.userId} value={m.userId}>{label(m)}</option>)}
        </select>
      </span>
    </Panel>
  );
}

/**
 * Agent page › Contact (gap-closing spec A5): the person to contact about
 * this agent. The owner, or a member of the owner's organization; no extra
 * permissions. Only the fleet's owner sees it. Nothing sends a notice to it
 * yet: the first notice is C5's pause and ask, which calls noticeRecipient.
 */
export function AgentContactPanel({ fleetId, agentId }: { fleetId: string; agentId: string }) {
  const [view, setView] = useState<ContactView | null>(null);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<Note | null>(null);

  // The agent each read or save was for: one that lands after a switch is dropped.
  const current = useRef(`${fleetId}/${agentId}`);
  current.current = `${fleetId}/${agentId}`;

  useEffect(() => {
    let live = true;
    // Another agent: nothing of the last one's shows while its own read is out.
    setView(null);
    setNote(null);
    setSaving(false);
    agentContactView(fleetId, agentId).then((v) => { if (live) setView(v); }, () => { if (live) setView(null); });
    return () => { live = false; };
  }, [fleetId, agentId]);

  async function change(userId: string) {
    if (!view?.ok) return;
    const asked = `${fleetId}/${agentId}`;
    setSaving(true);
    setNote(null);
    const got = await saveContactChoice(fleetId, agentId, userId, view);
    if (current.current !== asked) return;
    setView(got.view);
    setNote(got.note);
    setSaving(false);
  }

  return <ContactPanelView view={view} saving={saving} note={note} onChange={(id) => void change(id)} />;
}
