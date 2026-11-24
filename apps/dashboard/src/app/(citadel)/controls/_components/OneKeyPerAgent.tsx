'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { SegmentedControl, FONT_MONO } from '@whiteroom/ui';
import { agentKeyRuleGet, agentKeyRuleSet, agentNamesGet, controlFailure, isAuthError, WhiteRoomApiError } from '@/lib/whiteroom/client';
import { agentDisplay, credentialWords, type AgentKeyMode, type AgentKeyRuleResult } from '@/lib/agent-identity';
import { fmtDay } from '@/lib/format';
import { ROUTES } from '@/lib/routes';

/** Agents listed under the card; the rest are counted. */
const SHOWN = 5;

/**
 * Controls › "One key per agent" (gap-closing spec A3). Off or Watch: in
 * Watch, calls that came in without the agent's own WhiteRoom key are
 * counted, and nothing is blocked. Off shows the last 7 days, so the owner
 * sees what Watch would count first. Hidden for fleets outside the rule
 * (Sandbox, practice) and on engines without it.
 */
export function OneKeyPerAgent({ fleetId, authKey, onAuthError }: { fleetId: string; authKey?: string; onAuthError?: () => void }) {
  const [data, setData] = useState<AgentKeyRuleResult | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<Note | null>(null);

  // Returns whether it read. A failed read keeps what the card showed, so a
  // blip after a change doesn't hide the switch; the first read failing
  // leaves it hidden (an engine without the rule).
  const load = useCallback(async (): Promise<boolean> => {
    try {
      const [rule, named] = await Promise.all([agentKeyRuleGet(fleetId, authKey), agentNamesGet(fleetId, authKey)]);
      setData(rule);
      setNames(named ?? {});
      return true;
    } catch (e) {
      if (isAuthError(e)) onAuthError?.();
      return false;
    }
  }, [fleetId, authKey, onAuthError]);

  useEffect(() => { void load(); }, [load]);

  async function change(mode: AgentKeyMode) {
    if (!data || saving || mode === data.mode) return;
    setSaving(true);
    setNote(null);
    const got = await changeAgentKeyMode(fleetId, mode, authKey, load);
    if (got.keepMode) setData((d) => (d ? { ...d, mode } : d));
    setNote(got.note);
    setSaving(false);
  }

  return <OneKeyPerAgentView data={data} names={names} note={note} onChange={(m) => void change(m)} />;
}

type Note = { ok: boolean; text: string };

/**
 * Switches the mode, then reads the card again. `keepMode`: saved, but the
 * read failed, so the card shows the new mode with the counts it had.
 */
export async function changeAgentKeyMode(
  fleetId: string, mode: AgentKeyMode, authKey: string | undefined, reload: () => Promise<boolean>,
  set: typeof agentKeyRuleSet = agentKeyRuleSet,
): Promise<{ note: Note | null; keepMode: boolean }> {
  try {
    await set(fleetId, mode, authKey);
  } catch (e) {
    return { keepMode: false, note: { ok: false, text: e instanceof WhiteRoomApiError && e.reason ? e.reason
      : controlFailure(e) === 'refused' && e instanceof Error ? e.message
      : 'Couldn’t change it. Nothing changed. Try again.' } };
  }
  if (await reload()) return { keepMode: false, note: null };
  return { keepMode: true, note: { ok: true, text: 'Saved. The counts couldn’t be refreshed; reload the page to see them.' } };
}

/** The card for what was read: nothing for a fleet outside the rule, or before the first read. */
export function OneKeyPerAgentView({ data, names, note, onChange }: { data: AgentKeyRuleResult | null; names: Record<string, string>; note: Note | null; onChange: (m: AgentKeyMode) => void }) {
  if (!data?.applies || !data.summary) return null;
  const s = data.summary;
  const watching = data.mode === 'watch';
  const when = watching && data.since ? `Since ${fmtDay(data.since)}` : 'In the last 7 days';
  const n = s.unboundCalls;
  const unbound = s.agents.filter((a) => a.unboundCalls > 0);
  const more = unbound.length - SHOWN;

  return (
    <section className="wr-panel ctl-card" aria-labelledby="one-key-heading">
      <div className="ctl-card__head">
        <div style={{ minWidth: 0 }}>
          <h2 id="one-key-heading" className="wr-panel__title ctl-card__title">One key per agent</h2>
          <p className="ctl-cap" style={{ margin: '2px 0 0' }}>
            Each agent uses its own WhiteRoom key. In Watch, calls without one are counted. Nothing is blocked.
          </p>
        </div>
        <SegmentedControl<AgentKeyMode>
          label="One key per agent"
          value={data.mode}
          onChange={onChange}
          options={[{ value: 'off', label: 'Off' }, { value: 'watch', label: 'Watch' }]}
        />
      </div>
      {note && <p className="ctl-cap" role={note.ok ? 'status' : 'alert'} style={{ margin: 0, color: note.ok ? 'var(--tx2)' : 'var(--bad)' }}>{note.text}</p>}
      {!s.recorded ? (
        <p className="ctl-cap" style={{ margin: 0 }}>Calls aren’t recorded with their key yet. Counts start after the next update.</p>
      ) : n === 0 ? (
        <p className="ctl-cap" style={{ margin: 0 }}>{when}, every call came in on the agent’s own key.</p>
      ) : (
        <>
          <p style={{ margin: 0 }}>
            {when}, <strong>{n.toLocaleString('en-US')}</strong> {n === 1 ? 'call' : 'calls'} came in without the agent’s own key.{' '}
            <Link href={ROUTES.settings} className="wr-link">Create keys in Settings &rarr;</Link>
          </p>
          <ul className="wr-identity-list">
            {unbound.slice(0, SHOWN).map((a) => {
              const d = agentDisplay(a.agentId, names);
              return (
                <li key={a.agentId} className="wr-identity-list__row">
                  <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                    <Link href={`/agents/${encodeURIComponent(a.agentId)}`} className="wr-link">{d.name ?? <span style={{ fontFamily: FONT_MONO }}>{d.id}</span>}</Link>
                    {d.name && <span className="wr-agent-title__id">{d.id}</span>}
                    <span className="ctl-cap"> · {a.unboundCredentials.map(credentialWords).join(', ')}</span>
                  </span>
                  <span className="ctl-cap">{a.unboundCalls.toLocaleString('en-US')}</span>
                </li>
              );
            })}
          </ul>
          {(more > 0 || s.truncated) && <p className="ctl-cap" style={{ margin: 0 }}>{s.truncated ? 'More agents' : `${more} more ${more === 1 ? 'agent' : 'agents'}`} not shown.</p>}
        </>
      )}
    </section>
  );
}
