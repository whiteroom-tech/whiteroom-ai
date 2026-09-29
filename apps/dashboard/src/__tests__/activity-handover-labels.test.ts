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
    expect(m.watch).toBe('W12');
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
    for (const bad of [NaN, Infinity, -1, 2.5, '40000']) {
      expect(at({ type: 'handover_loop_detected', newLimit: bad }).said).toBe(
        'kept handing over after a call or two, so WhiteRoom raised its context limit to keep it working',
      );
      expect(at({ type: 'handover_results_truncated', results: bad }).said).toContain('had tool results too large');
    }
  });

  it('each type has its own label and code, not the generic fallback', () => {
    expect(at({ type: 'handover_loop_detected' }).code).toBe('H/L');
    expect(at({ type: 'handover_summary_failed' }).code).toBe('SUM');
    expect(at({ type: 'handover_results_truncated' }).code).toBe('CUT');
    expect(at({ type: 'some_unknown_event' }).code).toBe('LOG');
  });

  it('no label uses internal words', () => {
    for (const type of ['handover_loop_detected', 'handover_summary_failed', 'handover_results_truncated']) {
      expect(at({ type, results: 2, newLimit: 1 }).said).not.toMatch(/watch|shift|session|compression|truncat/i);
    }
  });
});
