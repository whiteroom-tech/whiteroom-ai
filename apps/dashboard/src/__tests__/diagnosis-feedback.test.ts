import { describe, it, expect, vi } from 'vitest';
import { feedbackOrThrow, sendWithFindingRecovery } from '@/lib/diagnosis/feedback';
import { WhiteRoomApiError } from '@/lib/whiteroom/client';
import type { RecommendationGetResult } from '@/lib/whiteroom/types';

const reloaded = (rec: Record<string, unknown> | null) =>
  async () => ({ contractVersion: '1', recommendation: (rec ? { status: 'open', ...rec } : null) as never, finding: null }) as RecommendationGetResult;
const conflict = () => new WhiteRoomApiError('HTTP 409', 409);

describe('an error in the feedback body', () => {
  it('is never taken for success', () => {
    expect(() => feedbackOrThrow({ success: false, error: 'finding_version mismatch' })).toThrow('finding_version mismatch');
    expect(() => feedbackOrThrow({ success: false })).toThrow();
    expect(feedbackOrThrow({ success: true })).toEqual({ success: true });
  });
});

describe('sending against the current finding', () => {
  it('done on the first try with the loaded id', async () => {
    const send = vi.fn(async () => ({}));
    expect(await sendWithFindingRecovery({ send, reload: reloaded({ currentFindingId: 'pf_2' }) }, 'pf_1')).toEqual({ kind: 'done' });
    expect(send).toHaveBeenCalledWith('pf_1');
  });

  it('on 409, retries once with the reloaded finding', async () => {
    const send = vi.fn().mockRejectedValueOnce(conflict()).mockResolvedValueOnce({});
    expect(await sendWithFindingRecovery({ send, reload: reloaded({ currentFindingId: 'pf_2' }) }, 'pf_1')).toEqual({ kind: 'done' });
    expect(send).toHaveBeenLastCalledWith('pf_2');
  });

  it('closed: the recommendation changed elsewhere, so nothing more is sent', async () => {
    for (const status of ['resolved', 'snoozed', 'dismissed', 'reported_implemented']) {
      const send = vi.fn().mockRejectedValue(conflict());
      expect(await sendWithFindingRecovery({ send, reload: reloaded({ status, currentFindingId: 'pf_2' }) }, 'pf_1')).toEqual({ kind: 'closed' });
      expect(send).toHaveBeenCalledTimes(1);
    }
  });

  it('with no loaded id, reloads first and never sends an empty one', async () => {
    const send = vi.fn(async () => ({}));
    expect(await sendWithFindingRecovery({ send, reload: reloaded({ currentFindingId: 'pf_2' }) }, '')).toEqual({ kind: 'done' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('pf_2');
  });

  it('failed: a non-409 error, a failed reload, or no usable finding', async () => {
    const other = await sendWithFindingRecovery({ send: vi.fn().mockRejectedValue(new WhiteRoomApiError('HTTP 502', 502)), reload: reloaded({ currentFindingId: 'pf_2' }) }, 'pf_1');
    expect(other.kind).toBe('failed');
    const reloadFails = await sendWithFindingRecovery({ send: vi.fn().mockRejectedValue(conflict()), reload: vi.fn().mockRejectedValue(new Error('down')) }, 'pf_1');
    expect(reloadFails.kind).toBe('failed');
    const same = vi.fn().mockRejectedValue(conflict());
    expect((await sendWithFindingRecovery({ send: same, reload: reloaded({ currentFindingId: 'pf_1' }) }, 'pf_1')).kind).toBe('failed');
    expect(same).toHaveBeenCalledTimes(1);
  });
});
