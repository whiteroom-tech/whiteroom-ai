'use client';

import { useEffect, useState } from 'react';
import { Panel } from '@whiteroom/ui';
import { identityMix } from '@/lib/whiteroom/client';
import { identityLines, percentText, type IdentityLine, type IdentityMixRow } from '@/lib/agent-identity';

export type MixState = { kind: 'loading' } | { kind: 'ok'; lines: IdentityLine[] } | { kind: 'failed' };

/** How a run's or an agent's calls were identified, fetched once. Hidden on engines without identity_mix. */
function useIdentityMix(fleetId: string, target: { agentId: string } | { runId: string }, authKey?: string, preview?: IdentityMixRow[]): MixState {
  const id = 'runId' in target ? `run:${target.runId}` : `agent:${target.agentId}`;
  const [state, setState] = useState<MixState>(preview ? { kind: 'ok', lines: identityLines(preview) } : { kind: 'loading' });
  useEffect(() => {
    if (preview) return;
    let live = true;
    setState({ kind: 'loading' });
    identityMix(fleetId, id.startsWith('run:') ? { runId: id.slice(4) } : { agentId: id.slice(6) }, authKey).then(
      (rows) => { if (live) setState({ kind: 'ok', lines: identityLines(rows) }); },
      () => { if (live) setState({ kind: 'failed' }); },
    );
    return () => { live = false; };
  }, [fleetId, id, authKey, preview]);
  return state;
}

/** Agent page: "How it connects" over the last 7 days, each way with its share of calls. */
export function AgentIdentityPanel({ fleetId, agentId, authKey, preview }: { fleetId: string; agentId: string; authKey?: string; preview?: IdentityMixRow[] }) {
  return <AgentIdentityView state={useIdentityMix(fleetId, { agentId }, authKey, preview)} />;
}

/** The panel for a read: hidden when it failed (an engine without identity_mix). */
export function AgentIdentityView({ state }: { state: MixState }) {
  if (state.kind === 'failed') return null;
  return (
    <Panel title="How it connects" actions={<span className="wr-agent-cap">Last 7 days</span>}>
      {state.kind === 'loading' ? (
        <div className="wr-agent-cap" aria-busy="true">Loading…</div>
      ) : state.lines.length === 0 ? (
        <div className="wr-agent-cap">No calls in the last 7 days.</div>
      ) : (
        <ul className="wr-identity-list">
          {state.lines.map((l) => (
            <li key={l.words} className="wr-identity-list__row" data-bound={l.bound || undefined}>
              <span>{l.words}</span>
              <span className="wr-agent-cap">{percentText(l)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** Run page: one line, "Identity: Own key", or each way with its share when the run mixed them. */
export function RunIdentityLine({ fleetId, runId, authKey }: { fleetId: string; runId: string; authKey?: string }) {
  const state = useIdentityMix(fleetId, { runId }, authKey);
  if (state.kind !== 'ok') return null;
  const text = runIdentityText(state.lines);
  if (!text) return null;
  return (
    <p className="wr-run-models">
      <span className="wr-agent-health__label">Identity</span>{' '}{text}
    </p>
  );
}

/** "Own key", or each way with its share when a run mixed them; null with no calls. */
export function runIdentityText(lines: readonly IdentityLine[]): string | null {
  if (lines.length === 0) return null;
  return lines.length === 1 ? lines[0].words : lines.map((l) => `${l.words} ${percentText(l)}`).join(' · ');
}
