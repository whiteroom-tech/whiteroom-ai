'use client';

import { useEffect, useState } from 'react';
import { Panel } from '@whiteroom/ui';
import { agentContactView, setAgentContact, type ContactView } from '@/lib/agent-contact-actions';

/**
 * Agent page › Contact (gap-closing spec A5): who is told about this agent.
 * The owner, or a member of the owner's organization; no extra permissions.
 * Only the fleet's owner sees it.
 */
export function AgentContactPanel({ fleetId, agentId }: { fleetId: string; agentId: string }) {
  const [view, setView] = useState<ContactView | null>(null);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    agentContactView(fleetId, agentId).then((v) => { if (live) setView(v); }, () => { if (live) setView(null); });
    return () => { live = false; };
  }, [fleetId, agentId]);

  if (!view?.ok) return null;
  const [owner, ...members] = view.candidates;
  if (!owner) return null;
  const label = (p: { email: string | null; name: string | null; userId: string }) => p.name ? `${p.name}${p.email ? ` (${p.email})` : ''}` : p.email ?? p.userId;

  async function change(userId: string) {
    setSaving(true);
    setNote(null);
    const res = await setAgentContact(fleetId, agentId, userId === owner.userId ? null : userId).catch(() => ({ ok: false as const, error: 'Couldn’t save. Try again.' }));
    if (res.ok) {
      const next = await agentContactView(fleetId, agentId).catch(() => null);
      if (next) setView(next);
      setNote({ ok: true, text: 'Saved.' });
    } else {
      setNote({ ok: false, text: res.error });
    }
    setSaving(false);
  }

  return (
    <Panel title="Contact">
      <p className="wr-agent-cap" style={{ margin: '0 0 6px' }}>
        {note ? <span role="status" style={{ color: note.ok ? 'var(--ok)' : 'var(--bad)' }}>{note.text}</span> : 'Who hears about this agent. It gives no extra access.'}
      </p>
      <span className="wr-select" style={{ display: 'block' }}>
        <select aria-label="Contact" disabled={saving} value={view.contact?.userId ?? owner.userId} onChange={(e) => void change(e.target.value)}>
          <option value={owner.userId}>You, the owner</option>
          {members.map((m) => <option key={m.userId} value={m.userId}>{label(m)}</option>)}
        </select>
      </span>
    </Panel>
  );
}
