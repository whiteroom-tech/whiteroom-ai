/**
 * Sending feedback against a Diagnosis recommendation's current finding. The
 * finding can change after the page loaded it (each republish is a new
 * version), which the engine answers with 409. Shared by the row buttons and
 * Add in Watch, so both recover the same way.
 */
import type { PerformanceFeedbackResult, RecommendationGetResult } from '@/lib/whiteroom/types';

export type FeedbackOutcome =
  | { kind: 'done' }
  /** The recommendation is no longer open (resolved, snoozed, dismissed meanwhile): nothing to send. */
  | { kind: 'closed' }
  | { kind: 'failed'; error: unknown };

/**
 * The engine can report a failed feedback in the body without the request
 * failing (success: false, error). Every sender goes through this, so such a
 * reply is never taken for success.
 */
export function feedbackOrThrow(res: PerformanceFeedbackResult): PerformanceFeedbackResult {
  if (res.error || res.success === false) throw new Error(res.error ?? 'Feedback was not accepted.');
  return res;
}

export const httpStatus = (e: unknown) => (e && typeof e === 'object' && 'status' in e ? (e as { status?: number }).status : undefined);

/**
 * Sends with the loaded finding id. Without one, or on 409, reloads the
 * recommendation and sends once more with its current finding.
 */
export async function sendWithFindingRecovery(
  deps: { send: (findingId: string) => Promise<unknown>; reload: () => Promise<RecommendationGetResult> },
  currentFindingId: string | null | undefined,
): Promise<FeedbackOutcome> {
  let conflict: unknown = null;
  if (currentFindingId) {
    try {
      await deps.send(currentFindingId);
      return { kind: 'done' };
    } catch (error) {
      if (httpStatus(error) !== 409) return { kind: 'failed', error };
      conflict = error;
    }
  }
  try {
    const fresh = (await deps.reload()).recommendation;
    if (fresh && fresh.status !== 'open') return { kind: 'closed' };
    const findingId = fresh?.currentFindingId;
    // No id, or the same finding, would only fail again.
    if (!findingId || findingId === currentFindingId) {
      return { kind: 'failed', error: conflict ?? new Error('The recommendation has no current finding.') };
    }
    await deps.send(findingId);
    return { kind: 'done' };
  } catch (error) {
    return { kind: 'failed', error };
  }
}
