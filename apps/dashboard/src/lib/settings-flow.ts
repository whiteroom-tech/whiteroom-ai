import type { DataSettings } from '@/lib/whiteroom/client';

/** Shown when the engine answered but didn't apply a change. */
export const NOT_APPLIED = 'This WhiteRoom engine didn’t apply the change. Try again later.';

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

export type ConfirmKind = 'notesOff' | 'feedOff' | 'removePersonal';

/**
 * Whether a data setting change asks first (compression spec §14.2):
 * anything that deletes what's stored or changes what agents keep. Turning
 * something back on, or keeping personal details, saves straight away.
 */
export function confirmKind(patch: Partial<DataSettings>): ConfirmKind | null {
  if (patch.handover_persistence === false) return 'notesOff';
  if (patch.content_capture === false) return 'feedOff';
  if (patch.personal_data === 'exclude') return 'removePersonal';
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
