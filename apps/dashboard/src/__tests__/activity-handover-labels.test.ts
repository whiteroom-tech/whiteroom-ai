import { describe, it, expect } from 'vitest';
import { eventModel } from '@/lib/activity';
import type { AuditEntry } from '@/lib/whiteroom/types';

const at = (e: Record<string, unknown>) =>
  eventModel({ id: 'e1', timestamp: '2026-09-29T12:00:00.000Z', agentId: 'lead-agent', ...e } as AuditEntry, Date.parse('2026-09-29T12:05:00.000Z'));

describe('handover health labels', () => {
  it('says the agent saved its progress, never how; only a self handover made its context smaller', () => {
    expect(at({ type: 'handover_out', toAgent: 'writer-agent' }).said).toBe('saved its progress');
    expect(at({ type: 'handover', toAgent: 'writer-agent' }).said).toBe('saved its progress');
    expect(at({ type: 'handover_in', fromAgent: 'writer-agent' }).said).toBe('continued its work');
    expect(at({ type: 'self_handover' }).said).toBe('made its context smaller');
    expect(at({ type: 'handover_unrecorded' }).said).toBe("saved its progress while records couldn't be written; it was recorded later");
    expect(at({ type: 'rest_start' }).said).toBe('paused for a moment');
    expect(at({ type: 'rest_end' }).said).toBe('started again');
  });

  it('handover loop names the new limit from the payload', () => {
    const m = at({ type: 'handover_loop_detected', previousLimit: 20000, newLimit: 40000, watchNumber: 12 });
    expect(m.who).toBe('Lead-agent');
    expect(m.said).toBe('ran out of room after a call or two, so WhiteRoom gave it more room (up to 40,000 tokens) to keep working');
    expect(m.code).toBe('H/L');
    expect(m.watch).toBe('#12');
  });

  it('handover loop still reads well without a limit', () => {
    expect(at({ type: 'handover_loop_detected' }).said).toBe(
      'ran out of room after a call or two, so WhiteRoom gave it more room to keep working',
    );
  });

  it('summary failure', () => {
    const m = at({ type: 'handover_summary_failed', outcome: 'timeout', watchNumber: 4 });
    expect(m.said).toBe("couldn't save all of its progress");
    expect(m.tone).toBe('wouldBlock');
  });

  it('truncated results use the count, singular and plural', () => {
    expect(at({ type: 'handover_results_truncated', results: 3, rawChars: 9000 }).said).toBe(
      'had 3 tool results too large to keep, so some were cut',
    );
    expect(at({ type: 'handover_results_truncated', results: 1 }).said).toContain('1 tool result too large');
    expect(at({ type: 'handover_results_truncated' }).said).toContain('had tool results too large');
  });

  it('malformed numbers are left out, never printed', () => {
    for (const bad of [0, NaN, Infinity, -1, 2.5, '40000']) {
      expect(at({ type: 'handover_loop_detected', newLimit: bad }).said).toBe(
        'ran out of room after a call or two, so WhiteRoom gave it more room to keep working',
      );
      expect(at({ type: 'handover_results_truncated', results: bad }).said).toContain('had tool results too large');
    }
  });

  it('a repeat-work raise says why', () => {
    expect(at({ type: 'handover_loop_detected', reason: 'repeated_work', newLimit: 37500 }).said).toBe(
      'kept redoing work it had already done, so WhiteRoom gave it more room (up to 37,500 tokens) to finish',
    );
  });

  it('a deferred handover and a lowered limit', () => {
    const d = at({ type: 'handover_deferred', reason: 'reply_cut_off', deferrals: 1, watchNumber: 43 });
    expect(d.said).toBe('had a reply cut off at its output limit, so WhiteRoom gave it one more call to finish that step');
    expect(d.code).toBe('H/D');
    expect(at({ type: 'handover_deferred', reason: 'something_new', deferrals: 2 }).said).toBe('got one more call to finish a step');
    expect(at({ type: 'handover_deferred' }).said).toBe('got one more call to finish a step');
    expect(at({ type: 'handover_limit_lowered', newLimit: 25000 }).said).toBe('stopped redoing earlier work, so WhiteRoom gave it less room (25,000 tokens)');
    expect(at({ type: 'handover_limit_lowered' }).said).toBe('stopped redoing earlier work, so WhiteRoom gave it less room');
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
      expect(at({ type, results: 2, newLimit: 1, reason: 'repeated_work' }).said).not.toMatch(/watch|shift|session|compression|truncat|context limit|notes|summary|break/i);
    }
  });

  it('handover delivery and goal events read as sentences, never raw codes', () => {
    expect(at({ type: 'handover_delivery_abandoned' }).said).toBe('had too much saved progress to send in full, so some was left out');
    expect(at({ type: 'handover_chain_abandoned' }).said).toBe("couldn't get its saved progress back");
    expect(at({ type: 'handover_notes_resealed' }).said).toBe('had its saved progress cleaned and re-secured by WhiteRoom');
    expect(at({ type: 'goal_set', cleared: false }).said).toBe('got a new goal from its owner');
    expect(at({ type: 'goal_set', cleared: true }).said).toBe('had its goal cleared');
    expect(at({ type: 'run_started' }).said).toBe('was started on a new task');
    const settings = at({ type: 'data_settings_changed', agentId: undefined });
    expect(settings.who).toBe('WhiteRoom');
    expect(settings.said).toBe('data and privacy settings were changed for this fleet');
  });
});
