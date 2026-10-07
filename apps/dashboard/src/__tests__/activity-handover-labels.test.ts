import { describe, it, expect } from 'vitest';
import { eventModel } from '@/lib/activity';
import type { AuditEntry } from '@/lib/whiteroom/types';

const at = (e: Record<string, unknown>) =>
  eventModel({ id: 'e1', timestamp: '2026-09-29T12:00:00.000Z', agentId: 'lead-agent', ...e } as AuditEntry, Date.parse('2026-09-29T12:05:00.000Z'));

describe('handover health labels', () => {
  it('handover loop names the new limit from the payload', () => {
    const m = at({ type: 'handover_loop_detected', previousLimit: 20000, newLimit: 40000, watchNumber: 12 });
    expect(m.who).toBe('Lead-agent');
    expect(m.said).toBe('kept handing over after a call or two, so WhiteRoom raised its context limit to 40,000 tokens to keep it working');
    expect(m.code).toBe('H/L');
    expect(m.watch).toBe('#12');
  });

  it('handover loop still reads well without a limit', () => {
    expect(at({ type: 'handover_loop_detected' }).said).toBe(
      'kept handing over after a call or two, so WhiteRoom raised its context limit to keep it working',
    );
  });

  it('summary failure', () => {
    const m = at({ type: 'handover_summary_failed', outcome: 'timeout', watchNumber: 4 });
    expect(m.said).toBe("couldn't be summarised at handover, so it picked up again from a short note");
    expect(m.tone).toBe('wouldBlock');
  });

  it('truncated results use the count, singular and plural', () => {
    expect(at({ type: 'handover_results_truncated', results: 3, rawChars: 9000 }).said).toBe(
      'had 3 tool results too large to carry through its handover, so some were cut',
    );
    expect(at({ type: 'handover_results_truncated', results: 1 }).said).toContain('1 tool result too large');
    expect(at({ type: 'handover_results_truncated' }).said).toContain('had tool results too large');
  });

  it('malformed numbers are left out, never printed', () => {
    for (const bad of [0, NaN, Infinity, -1, 2.5, '40000']) {
      expect(at({ type: 'handover_loop_detected', newLimit: bad }).said).toBe(
        'kept handing over after a call or two, so WhiteRoom raised its context limit to keep it working',
      );
      expect(at({ type: 'handover_results_truncated', results: bad }).said).toContain('had tool results too large');
    }
  });

  it('a repeat-work raise says why', () => {
    expect(at({ type: 'handover_loop_detected', reason: 'repeated_work', newLimit: 37500 }).said).toBe(
      'kept redoing work it had already done after each handover, so WhiteRoom raised its context limit to 37,500 tokens to give it room to finish',
    );
  });

  it('a deferred handover and a lowered limit', () => {
    const d = at({ type: 'handover_deferred', reason: 'reply_cut_off', deferrals: 1, watchNumber: 43 });
    expect(d.said).toBe('had a reply cut off at its output limit, so its handover waited one call to let it finish that step');
    expect(d.code).toBe('H/D');
    expect(at({ type: 'handover_deferred', reason: 'something_new', deferrals: 2 }).said).toBe('had its handover wait one call to let it finish a step');
    expect(at({ type: 'handover_deferred' }).said).toBe('had its handover wait one call to let it finish a step');
    expect(at({ type: 'handover_limit_lowered', newLimit: 25000 }).said).toBe('stopped redoing earlier work, so WhiteRoom lowered its context limit to 25,000 tokens');
    expect(at({ type: 'handover_limit_lowered' }).said).toBe('stopped redoing earlier work, so WhiteRoom lowered its context limit');
  });

  it('each type has its own label and code, not the generic fallback', () => {
    expect(at({ type: 'handover_deferred' }).code).toBe('H/D');
    expect(at({ type: 'handover_limit_lowered' }).code).toBe('H/R');
    expect(at({ type: 'handover_loop_detected' }).code).toBe('H/L');
    expect(at({ type: 'handover_summary_failed' }).code).toBe('SUM');
    expect(at({ type: 'handover_results_truncated' }).code).toBe('CUT');
    expect(at({ type: 'some_unknown_event' }).code).toBe('LOG');
  });

  it('no label uses internal words', () => {
    for (const type of ['handover_loop_detected', 'handover_summary_failed', 'handover_results_truncated', 'handover_deferred', 'handover_limit_lowered']) {
      expect(at({ type, results: 2, newLimit: 1, reason: 'repeated_work' }).said).not.toMatch(/watch|shift|session|compression|truncat/i);
    }
  });

  it('handover delivery and goal events read as sentences, never raw codes', () => {
    expect(at({ type: 'handover_delivery_abandoned' }).said).toBe('had handover notes too large to deliver, so WhiteRoom sent a short version');
    expect(at({ type: 'handover_chain_abandoned' }).said).toBe("couldn't receive its handover notes, so it carried on without them");
    expect(at({ type: 'goal_set', cleared: false }).said).toBe('got a new goal from its owner');
    expect(at({ type: 'goal_set', cleared: true }).said).toBe('had its goal cleared');
    expect(at({ type: 'run_started' }).said).toBe('was started on a new task');
    const settings = at({ type: 'data_settings_changed', agentId: undefined });
    expect(settings.who).toBe('WhiteRoom');
    expect(settings.said).toBe('data and privacy settings were changed for this fleet');
  });
});
