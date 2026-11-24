'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { SegmentedControl, FONT_MONO } from '@whiteroom/ui';
import { agentKeyReadiness, agentKeyRuleGet, agentKeyRuleSet, agentNamesGet, agentRetire, changeFailureText, isAuthError } from '@/lib/whiteroom/client';
import { agentDisplay, credentialWords, type AgentKeyMode, type AgentKeyReadiness, type AgentKeyRuleResult, type ReadinessBlocker } from '@/lib/agent-identity';
import { fmtDay } from '@/lib/format';
import { ROUTES } from '@/lib/routes';

/** Agents listed under the card; the rest are counted. */
const SHOWN = 5;

/**
 * Controls › "One key per agent" (gap-closing spec A3/A4). In Watch, calls
 * that came in without the agent's own WhiteRoom key are counted, and
 * nothing is blocked. Off shows the last 7 days, so the owner sees what
 * Watch would count first. Enforce refuses those calls; it opens only once
 * readiness passes, and the engine rechecks it at the switch. Hidden for
 * fleets outside the rule (Sandbox, practice) and on engines without it.
 */
export function OneKeyPerAgent({ fleetId, authKey, onAuthError }: { fleetId: string; authKey?: string; onAuthError?: () => void }) {
  const [data, setData] = useState<AgentKeyRuleResult | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  // Null: not read (an engine before Enforce), so no Enforce is offered.
  const [readiness, setReadiness] = useState<AgentKeyReadiness | null>(null);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<Note | null>(null);

  // Returns whether it read. A failed read keeps what the card showed, so a
  // blip after a change doesn't hide the switch; the first read failing
  // leaves it hidden (an engine without the rule).
  // The fleet and key each read was made for: a read for an earlier one is dropped when it lands.
  const current = useRef({ fleetId, authKey });
  current.current = { fleetId, authKey };
  const load = useCallback(async (): Promise<boolean> => {
    const asked = { fleetId, authKey };
    const stillCurrent = () => current.current.fleetId === asked.fleetId && current.current.authKey === asked.authKey;
    try {
      // Readiness failing on its own (an older engine) leaves the rest of the card as it was.
      const [rule, named, ready] = await Promise.all([agentKeyRuleGet(fleetId, authKey), agentNamesGet(fleetId, authKey), agentKeyReadiness(fleetId, authKey).catch(() => null)]);
      if (!stillCurrent()) return false;
      setData(rule);
      setNames(named ?? {});
      setReadiness(ready);
      return true;
    } catch (e) {
      if (stillCurrent() && isAuthError(e)) onAuthError?.();
      return false;
    }
  }, [fleetId, authKey, onAuthError]);

  useEffect(() => {
    // Another fleet: nothing of the last one's shows while its own read is out.
    setData(null);
    setNames({});
    setReadiness(null);
    setNote(null);
    setSaving(false);
    void load();
  }, [load]);

  async function change(mode: AgentKeyMode) {
    if (!data || saving || mode === data.mode) return;
    const asked = { fleetId, authKey };
    setSaving(true);
    setNote(null);
    const got = await changeAgentKeyMode(fleetId, mode, authKey, load, agentKeyRuleSet, readiness?.token);
    // The page moved to another fleet while it saved: nothing of this one's lands on that card.
    if (current.current.fleetId !== asked.fleetId || current.current.authKey !== asked.authKey) return;
    if (got.keepMode) setData((d) => (d ? { ...d, mode } : d));
    setNote(got.note);
    setSaving(false);
  }

  async function retire(agentId: string, retired: boolean) {
    if (saving) return;
    const asked = { fleetId, authKey };
    setSaving(true);
    setNote(null);
    const got = await retireAgent(fleetId, agentId, retired, authKey, load);
    if (current.current.fleetId !== asked.fleetId || current.current.authKey !== asked.authKey) return;
    setNote(got);
    setSaving(false);
  }

  return <OneKeyPerAgentView data={data} names={names} note={note} readiness={readiness} busy={saving} onChange={(m) => void change(m)} onRetire={(id, r) => void retire(id, r)} />;
}

type Note = { ok: boolean; text: string };

/**
 * Switches the mode, then reads the card again. `keepMode`: saved, but the
 * read failed, so the card shows the new mode with the counts it had.
 */
export async function changeAgentKeyMode(
  fleetId: string, mode: AgentKeyMode, authKey: string | undefined, reload: () => Promise<boolean>,
  set: typeof agentKeyRuleSet = agentKeyRuleSet, readinessToken?: string,
): Promise<{ note: Note | null; keepMode: boolean }> {
  try {
    await set(fleetId, mode, authKey, mode === 'enforce' ? readinessToken : undefined);
  } catch (e) {
    // Refused (not ready, or changed since the page loaded): the card reads again, so it shows why.
    if (mode === 'enforce') void reload();
    return { keepMode: false, note: { ok: false, text: changeFailureText(e, 'Couldn’t change it. Nothing changed. Try again.') } };
  }
  if (await reload()) return { keepMode: false, note: null };
  return { keepMode: true, note: { ok: true, text: 'Saved. The counts couldn’t be refreshed; reload the page to see them.' } };
}

/** Marks an agent retired (or not), then reads the card again. The note to show, or null. */
export async function retireAgent(
  fleetId: string, agentId: string, retired: boolean, authKey: string | undefined, reload: () => Promise<boolean>,
  call: typeof agentRetire = agentRetire,
): Promise<Note | null> {
  try {
    await call(fleetId, agentId, retired, authKey);
  } catch (e) {
    return { ok: false, text: changeFailureText(e, 'Couldn’t change it. Nothing changed. Try again.') };
  }
  return (await reload()) ? null : { ok: true, text: 'Saved. Reload the page to see it.' };
}

/** The card for what was read: nothing for a fleet outside the rule, or before the first read. */
export function OneKeyPerAgentView({ data, names, note, readiness = null, busy = false, onChange, onRetire = () => {} }: {
  data: AgentKeyRuleResult | null; names: Record<string, string>; note: Note | null;
  readiness?: AgentKeyReadiness | null; busy?: boolean;
  onChange: (m: AgentKeyMode) => void; onRetire?: (agentId: string, retired: boolean) => void;
}) {
  // Hidden only outside the rule: without counts the switch still shows.
  if (!data?.applies) return null;
  const s = data.summary;
  const watching = data.mode !== 'off';
  const enforcing = data.mode === 'enforce';
  // Enforce is offered once it's ready, and stays selectable while it's on.
  const canEnforce = enforcing || !!readiness?.ready;
  const when = watching && data.since ? `Since ${fmtDay(data.since)}` : 'In the last 7 days';
  const n = s?.unboundCalls ?? 0;
  const unbound = s?.agents.filter((a) => a.unboundCalls > 0) ?? [];
  const more = unbound.length - SHOWN;

  return (
    <section className="wr-panel ctl-card" aria-labelledby="one-key-heading">
      <div className="ctl-card__head">
        <div style={{ minWidth: 0 }}>
          <h2 id="one-key-heading" className="wr-panel__title ctl-card__title">One key per agent</h2>
          <p className="ctl-cap" style={{ margin: '2px 0 0' }}>
            {enforcing
              ? 'Each agent uses its own WhiteRoom key. Calls without one are refused.'
              : 'Each agent uses its own WhiteRoom key. In Watch, calls without one are counted. Nothing is blocked.'}
          </p>
        </div>
        <SegmentedControl<AgentKeyMode>
          label="One key per agent"
          value={data.mode}
          onChange={onChange}
          options={[
            { value: 'off', label: 'Off' },
            { value: 'watch', label: 'Watch' },
            ...(readiness || enforcing ? [{ value: 'enforce' as const, label: 'Enforce', disabled: !canEnforce || busy, title: canEnforce ? undefined : 'Not ready yet. See below.' }] : []),
          ]}
        />
      </div>
      {note && <p className="ctl-cap" role={note.ok ? 'status' : 'alert'} style={{ margin: 0, color: note.ok ? 'var(--tx2)' : 'var(--bad)' }}>{note.text}</p>}
      {!s ? (
        <p className="ctl-cap" style={{ margin: 0 }}>The counts aren’t available right now.</p>
      ) : !s.recorded ? (
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
                    {a.unboundCredentials.length > 0 && <span className="ctl-cap"> · {a.unboundCredentials.map(credentialWords).join(', ')}</span>}
                  </span>
                  <span className="ctl-cap">{a.unboundCalls.toLocaleString('en-US')}</span>
                </li>
              );
            })}
          </ul>
          {(more > 0 || s.truncated) && <p className="ctl-cap" style={{ margin: 0 }}>{s.truncated ? 'More agents' : `${more} more ${more === 1 ? 'agent' : 'agents'}`} not shown.</p>}
        </>
      )}
      {readiness && !enforcing && <EnforceReadiness readiness={readiness} names={names} busy={busy} onRetire={onRetire} />}
    </section>
  );
}

const DAY_MS = 86_400_000;

/** " Ready Nov 27 at the earliest.", or nothing for a time that can't be read. */
function readyBy(ms: number): string {
  const day = Number.isFinite(ms) ? fmtDay(ms) : '';
  return day ? ` Ready ${day} at the earliest.` : '';
}

/** One line per blocker, in plain words. A blocker this build doesn't know isn't shown, but still keeps Enforce closed. */
export function blockerText(b: ReadinessBlocker, days: number): string | null {
  switch (b.kind) {
    case 'not_recorded': return 'Calls aren’t recorded with their key yet.';
    case 'not_watching': return `Turn on Watch first. Enforce opens after ${days} days in Watch.`;
    case 'watch_too_short': return `Watch needs ${days} days.${readyBy(Date.parse(b.readyAt))}`;
    case 'unbound_calls': return `${b.calls.toLocaleString('en-US')} ${b.calls === 1 ? 'call' : 'calls'} in the last ${days} days came in without the agent’s own key.`;
    case 'capture_gaps': {
      return `Some calls weren’t recorded in the last ${days} days.${b.lastAt ? readyBy(Date.parse(b.lastAt) + days * DAY_MS) : ''}`;
    }
    // Listed agent by agent below.
    case 'agents_not_seen': return null;
    default: return null;
  }
}

/** Under the counts, while not in Enforce: what's left before Enforce opens, and the retired agents. */
function EnforceReadiness({ readiness: r, names, busy, onRetire }: { readiness: AgentKeyReadiness; names: Record<string, string>; busy: boolean; onRetire: (agentId: string, retired: boolean) => void }) {
  const lines = r.blockers.map((b) => blockerText(b, r.observationDays)).filter((t): t is string => !!t);
  const notSeen = r.blockers.find((b): b is Extract<ReadinessBlocker, { kind: 'agents_not_seen' }> => b.kind === 'agents_not_seen')?.agentIds ?? [];
  const label = (id: string) => {
    const d = agentDisplay(id, names);
    return <>{d.name ?? <span style={{ fontFamily: FONT_MONO }}>{d.id}</span>}{d.name && <span className="wr-agent-title__id">{d.id}</span>}</>;
  };
  return (
    <div className="wr-key-ready" role="group" aria-labelledby="one-key-enforce-heading">
      <h3 id="one-key-enforce-heading" className="wr-agent-cap" style={{ margin: 0 }}>Enforce</h3>
      {r.ready ? (
        <p className="ctl-cap" style={{ margin: 0 }}>Ready. Calls without the agent’s own key will be refused.</p>
      ) : (
        <>
          <p className="ctl-cap" style={{ margin: 0 }}>Not ready yet. Enforce opens after {r.observationDays} days in Watch with every agent on its own key.</p>
          {lines.length > 0 && <ul className="wr-key-ready__list">{lines.map((t) => <li key={t}>{t}</li>)}</ul>}
        </>
      )}
      {notSeen.length > 0 && (
        <>
          <p className="ctl-cap" style={{ margin: 0 }}>Not seen on its own key yet. Retire an agent that no longer runs.</p>
          <ul className="wr-identity-list">
            {notSeen.slice(0, SHOWN).map((id) => (
              <li key={id} className="wr-identity-list__row">
                <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}><Link href={`/agents/${encodeURIComponent(id)}`} className="wr-link">{label(id)}</Link></span>
                <button type="button" className="wr-btn wr-btn--secondary wr-btn--h28" disabled={busy} onClick={() => onRetire(id, true)}>Mark retired</button>
              </li>
            ))}
          </ul>
          {notSeen.length > SHOWN && <p className="ctl-cap" style={{ margin: 0 }}>{notSeen.length - SHOWN} more not shown.</p>}
        </>
      )}
      {r.retired.length > 0 && (
        <ul className="wr-identity-list">
          {r.retired.slice(0, SHOWN).map((a) => (
            <li key={a.agentId} className="wr-identity-list__row">
              <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{label(a.agentId)} <span className="ctl-cap">· Retired</span></span>
              <button type="button" className="wr-btn wr-btn--secondary wr-btn--h28" disabled={busy} onClick={() => onRetire(a.agentId, false)}>Undo</button>
            </li>
          ))}
        </ul>
      )}
      {r.retired.length > SHOWN && <p className="ctl-cap" style={{ margin: 0 }}>{r.retired.length - SHOWN} more retired not shown.</p>}
    </div>
  );
}
