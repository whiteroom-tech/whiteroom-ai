'use client';

import { useState } from 'react';
import { Button, Panel, TextInput } from '@whiteroom/ui';
import { agentRename, controlFailure, WhiteRoomApiError } from '@/lib/whiteroom/client';
import { cleanAgentName } from '@/lib/agent-identity';

/**
 * Agent page › Name: a display name over the agent's id. The id never
 * changes, so its history, rules, holds and keys stay as they are. Only the
 * fleet's owner can save one; the engine's refusal is shown as it is.
 */
export function AgentNamePanel({ fleetId, agentId, authKey, name, onSaved }: {
  fleetId: string;
  agentId: string;
  authKey?: string;
  name: string | null;
  onSaved: (name: string | null) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  async function save(value: string) {
    const clean = cleanAgentName(value);
    if ('error' in clean) { setNote({ ok: false, text: clean.error }); return; }
    setSaving(true);
    setNote(null);
    try {
      const saved = await agentRename(fleetId, agentId, clean.name, authKey);
      onSaved(saved);
      setDraft(null);
      setNote({ ok: true, text: saved ? 'Saved.' : 'Name cleared.' });
    } catch (e) {
      const why = e instanceof WhiteRoomApiError && e.reason ? e.reason
        : controlFailure(e) === 'refused' && e instanceof Error ? e.message
        : 'Couldn’t save. Try again.';
      setNote({ ok: false, text: why });
    } finally {
      setSaving(false);
    }
  }

  const value = draft ?? name ?? '';
  const changed = draft !== null && draft.trim() !== (name ?? '');
  return (
    <Panel title="Name">
      <p className="wr-agent-cap" style={{ margin: '0 0 6px' }}>
        {note ? <span role="status" style={{ color: note.ok ? 'var(--ok)' : 'var(--bad)' }}>{note.text}</span> : 'Shown with its id on this page and in alerts'}
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <TextInput ariaLabel="Agent name" value={value} onChange={setDraft} placeholder="e.g. Claims triage bot" className="w-full" />
        </div>
        <Button disabled={!changed} busy={saving} busyLabel="Saving…" onClick={() => void save(value)}>Save</Button>
        {name && draft === null && <Button variant="ghost" disabled={saving} onClick={() => void save('')}>Clear</Button>}
      </div>
    </Panel>
  );
}
