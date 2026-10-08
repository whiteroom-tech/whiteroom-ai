import { controlFailure, type DataSettings } from '@/lib/whiteroom/client';

/** Shown when the engine answered but didn't apply a change. */
export const NOT_APPLIED = 'This WhiteRoom engine didn’t apply the change. Try again later.';

/** The engine refused a change because someone else changed the same thing first: re-read it before trying again. */
export const changedElsewhere = (message: string) => /changed elsewhere/i.test(message);

/** Shown after such a refusal, once the latest version is on screen. */
export const CHANGED_ELSEWHERE = 'This was changed elsewhere. The latest is shown now; try again if you still want your change.';

/** Shown after such a refusal when the latest couldn't be read. */
export const CHANGED_ELSEWHERE_RELOAD = 'This was changed elsewhere. Reload the page to see the latest, then try again.';

export type LoadOutcome<T> = { kind: 'loaded'; value: T } | { kind: 'hidden' } | { kind: 'failed' };

/**
 * Loads what an optional panel shows. `hidden` when the engine doesn't have
 * the action (null), refuses this viewer, or the session was rejected: trying
 * again can't help, so the panel stays out of the way. `failed` for anything
 * else (network, server error), so the panel says it couldn't load instead of
 * silently vanishing.
 */
export async function loadOptional<T>(get: () => Promise<T | null>): Promise<LoadOutcome<T>> {
  try {
    const v = await get();
    return v == null ? { kind: 'hidden' } : { kind: 'loaded', value: v };
  } catch (e) {
    return controlFailure(e) === 'failed' ? { kind: 'failed' } : { kind: 'hidden' };
  }
}

export type ChangeOutcome<T> = { kind: 'applied'; value: T } | { kind: 'stale' } | { kind: 'failed'; message: string };

/**
 * Sends one settings change for whatever is on screen (a fleet, an agent).
 * `stale` when the user moved to another one meanwhile: its result is
 * dropped, never shown under the new one. `failed` when the request threw,
 * or the engine answered without applying it (null, or a reply `applied`
 * rejects): an unapplied change is never shown as saved.
 */
export async function applyChange<T>(
  send: () => Promise<T | null | undefined>,
  stillCurrent: () => boolean,
  applied: (v: T) => boolean = () => true,
): Promise<ChangeOutcome<T>> {
  try {
    const v = await send();
    if (!stillCurrent()) return { kind: 'stale' };
    if (v == null || !applied(v)) return { kind: 'failed', message: NOT_APPLIED };
    return { kind: 'applied', value: v };
  } catch (e) {
    if (!stillCurrent()) return { kind: 'stale' };
    return { kind: 'failed', message: e instanceof Error ? e.message : 'That didn’t save. Try again.' };
  }
}

export type ConfirmKind = 'notesOff' | 'feedOff' | 'removePersonal' | 'shorterRetention';

/**
 * Whether a data setting change asks first (compression spec §14.2):
 * anything that deletes what's stored or changes what agents keep. Turning
 * something back on, or keeping personal details, saves straight away.
 */
export function confirmKind(patch: Partial<DataSettings>, current?: Partial<DataSettings> | null): ConfirmKind | null {
  if (patch.handover_persistence === false) return 'notesOff';
  if (patch.content_capture === false) return 'feedOff';
  if (patch.personal_data === 'exclude') return 'removePersonal';
  // A shorter retention deletes older saved notes; a longer one deletes nothing.
  const was = current?.handover_max_age_hours;
  if (patch.handover_max_age_hours !== undefined && was != null && patch.handover_max_age_hours < was) return 'shorterRetention';
  return null;
}

/**
 * The settings shown after a save: the engine's reply over what was on
 * screen, without its `success` flag. A field the reply leaves out keeps its
 * last known value, so its control doesn't disappear.
 */
export function mergeSettingsReply<T extends object>(prev: T | null, reply: Partial<T> & { success?: boolean }): T {
  const fresh: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(reply)) if (k !== 'success' && v !== undefined) fresh[k] = v;
  return { ...(prev ?? {}), ...fresh } as T;
}
