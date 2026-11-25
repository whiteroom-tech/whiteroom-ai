'use client';

// Replay (gap-closing spec C3): "Estimate" under a rule's settings, for the
// rule types the engine can estimate. It checks the rule as drafted against
// the fleet's last 7 days of calls. Only the fleet owner can start one.

import { useEffect, useRef, useState } from 'react';
import { replayGet, replayStart, WhiteRoomApiError } from '@/lib/whiteroom/client';
import { REPLAY_DAYS, REPLAY_RULE_TYPES, partialLine, replayLine, replayScopeNote, type ReplayResult } from '@/lib/replay';

const POLL_MS = 2_000;
/** The engine gives up after 10 minutes; stop asking a little after. */
const GIVE_UP_MS = 11 * 60_000;
/** Reads that fail in a row (a network blip) before the estimate gives up. */
const MAX_MISSED_READS = 5;

type State =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; result: ReplayResult; for: string }
  | { kind: 'error'; message: string };

/** The words for a refused or failed start. */
export function startErrorText(e: unknown): string {
  const status = e instanceof WhiteRoomApiError ? e.status : undefined;
  if (status === 404) return 'Estimates aren’t on for this fleet yet.';
  if (status === 403) return 'Only the fleet owner can run an estimate.';
  if (status === 409) return 'An estimate is already running for this fleet. Try again in a minute.';
  if (status === 400 && e instanceof WhiteRoomApiError && e.reason) return e.reason;
  return 'The estimate couldn’t run. Try again in a minute.';
}

/** Runs one estimate and waits for it. Exported for tests. */
export async function runEstimate(
  fleetId: string,
  rule: { ruleType: string; params: unknown; appliesTo: unknown },
  authKey: string | undefined,
  opts: { sleep?: (ms: number) => Promise<void>; now?: () => number; cancelled?: () => boolean } = {},
): Promise<{ result: ReplayResult } | { error: string } | null> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  let id: string | null;
  try {
    id = await replayStart(fleetId, rule, REPLAY_DAYS, authKey);
  } catch (e) {
    return { error: startErrorText(e) };
  }
  if (id === null) return { error: 'This kind of rule can’t be estimated yet.' };
  const until = now() + GIVE_UP_MS;
  let missed = 0;
  while (now() < until) {
    await sleep(POLL_MS);
    if (opts.cancelled?.()) return null;
    try {
      const run = await replayGet(fleetId, id, authKey);
      if (run.status === 'done' && run.result) return { result: run.result };
      if (run.status === 'failed') return { error: 'The estimate stopped before it finished. Try again.' };
      missed = 0;
    } catch (e) {
      // A refusal or a reply this page can't read won't change on the next poll; a missed read is retried a few times.
      const status = e instanceof WhiteRoomApiError ? e.status : undefined;
      if (status === 200) return { error: 'This page can’t read the estimate. Reload it and try again.' };
      if (status === 401 || status === 403) return { error: 'You’re no longer signed in to this fleet. Reload the page.' };
      if (status === 404) return { error: 'The estimate is gone. Run it again.' };
      if (++missed >= MAX_MISSED_READS) return { error: 'The estimate couldn’t be read. Try again in a minute.' };
    }
  }
  return { error: 'The estimate is taking too long. Try again later.' };
}

export function ReplayEstimate({ fleetId, authKey, ruleType, params, appliesTo, disabledReason }: {
  fleetId: string;
  authKey: string | undefined;
  ruleType: string;
  params: unknown;
  appliesTo: unknown;
  /** Why the draft can't be estimated as it stands (an empty list, say); null when it can. */
  disabledReason: string | null;
}) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const alive = useRef(true);
  // Set on every mount: StrictMode mounts, cleans up and mounts again.
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  if (!REPLAY_RULE_TYPES.has(ruleType)) return null;

  const current = JSON.stringify([params, appliesTo]);
  const start = async () => {
    setState({ kind: 'running' });
    const out = await runEstimate(fleetId, { ruleType, params, appliesTo }, authKey, { cancelled: () => !alive.current });
    if (!out || !alive.current) return;
    setState('result' in out ? { kind: 'done', result: out.result, for: current } : { kind: 'error', message: out.error });
  };
  // A result for settings since changed no longer applies.
  const shown = state.kind === 'done' && state.for !== current ? { kind: 'idle' as const } : state;
  const partial = shown.kind === 'done' ? partialLine(shown.result.partial) : null;

  return (
    <div className="wr-replay" aria-live="polite">
      <div className="wr-replay__row">
        <button type="button" className="wr-btn wr-btn--secondary wr-btn--h28" disabled={shown.kind === 'running' || disabledReason !== null} onClick={() => void start()}>
          {shown.kind === 'running' ? 'Estimating…' : `Estimate on the last ${REPLAY_DAYS} days`}
        </button>
        {disabledReason && <span className="wr-replay__note">{disabledReason}</span>}
      </div>
      {shown.kind === 'done' && (
        <p className="wr-replay__line">
          {replayLine(shown.result, ruleType)} <span className="wr-replay__note">Estimate.</span>
          {partial && <span className="wr-replay__note"> {partial}</span>}
        </p>
      )}
      {shown.kind === 'done' && replayScopeNote(ruleType) && <p className="wr-replay__line wr-replay__note">{replayScopeNote(ruleType)}</p>}
      {shown.kind === 'error' && <p className="wr-replay__line wr-replay__line--err">{shown.message}</p>}
    </div>
  );
}
