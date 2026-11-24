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
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [rule, named] = await Promise.all([agentKeyRuleGet(fleetId, authKey), agentNamesGet(fleetId, authKey)]);
      setData(rule);
      setNames(named ?? {});
    } catch (e) {
      if (isAuthError(e)) onAuthError?.();
      setData(null);
    }
  }, [fleetId, authKey, onAuthError]);

  useEffect(() => { void load(); }, [load]);

  async function change(mode: AgentKeyMode) {
    if (!data || saving || mode === data.mode) return;
    setSaving(true);
    setNote(null);
    try {
      await agentKeyRuleSet(fleetId, mode, authKey);
      await load();
    } catch (e) {
      setNote(e instanceof WhiteRoomApiError && e.reason ? e.reason
        : controlFailure(e) === 'refused' && e instanceof Error ? e.message
        : 'Couldn’t change it. Nothing changed. Try again.');
    } finally {
      setSaving(false);
    }
  }

  if (!data?.applies || !data.summary) return null;
  const s = data.summary;
  const watching = data.mode === 'watch';
  const when = watching && data.since ? `Since ${fmtDay(data.since)}` : 'In the last 7 days';
  const n = s.unboundCalls;

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
          onChange={(m) => void change(m)}
          options={[{ value: 'off', label: 'Off' }, { value: 'watch', label: 'Watch' }]}
        />
      </div>
      {note && <p className="ctl-cap" role="alert" style={{ margin: 0, color: 'var(--bad)' }}>{note}</p>}
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
            {s.agents.filter((a) => a.unboundCalls > 0).slice(0, SHOWN).map((a) => {
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
          {(() => {
            const more = s.agents.filter((a) => a.unboundCalls > 0).length - SHOWN;
            return more > 0 || s.truncated ? <p className="ctl-cap" style={{ margin: 0 }}>{s.truncated ? 'More agents' : `${more} more ${more === 1 ? 'agent' : 'agents'}`} not shown.</p> : null;
          })()}
        </>
      )}
    </section>
  );
}
