// Runs › Check audit trail: what the dialog says for each result of the chain check.
import { describe, expect, it } from 'vitest';
import { auditCheckText } from '@/components/runs/RunsDialogs';
import type { AuditIntegrity } from '@/lib/whiteroom/types';

const info = (x: Partial<AuditIntegrity> = {}): AuditIntegrity => ({
  fleetId: 'f', mode: 'sequenced', headSeq: 2045, verifiedThroughSeq: 939, verifiedAt: null, prunedBeforeTracking: true, legacyEvents: 0,
  gaps: { count: 0, recent: [] }, anchoring: { enabled: false }, ...x,
});

describe('audit check wording', () => {
  it('says nothing changed or missing only when the check passed with no recorded gaps', () => {
    expect(auditCheckText({ valid: true, eventsVerified: 939, message: '' }, info())).toEqual({
      tone: 'ok', title: 'Nothing changed or missing', detail: 'Verified through event 939 of 2,045. Events before tracking started aren’t covered.',
    });
    expect(auditCheckText({ valid: true, eventsVerified: 939, message: '' }, info({ gaps: { count: 2, recent: [] }, prunedBeforeTracking: false })))
      .toEqual({ tone: 'neutral', title: 'Nothing changed', detail: 'Verified through event 939 of 2,045. 2 recorded gaps where events may be missing.' });
  });
  it('names a problem, and never passes a partial check', () => {
    expect(auditCheckText({ valid: false, eventsVerified: 10, message: 'Event 11 was changed.' }, null)).toEqual({ tone: 'bad', title: 'A problem was found', detail: 'Event 11 was changed.' });
    expect(auditCheckText({ valid: null, eventsVerified: 500, message: '' }, null).tone).toBe('neutral');
  });
});
