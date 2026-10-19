// Settings › Data and privacy notes (P0 5a): the live feed can't be turned on
// while personal details are removed, and a fleet that carries notes only
// within a labeled run says so.

import { describe, it, expect } from 'vitest';
import { carriesOnlyInLabeledRuns, liveFeedLocked } from '@/components/settings/DataPrivacySection';
import type { DataSettings } from '@/lib/whiteroom/client';

const base: DataSettings = { handover_persistence: true, content_capture: false, personal_data: 'keep' };

describe('data and privacy notes', () => {
  it('locks the live feed only while it is off and personal details are removed', () => {
    expect(liveFeedLocked({ ...base, personal_data: 'exclude' })).toBe(true);
    expect(liveFeedLocked(base)).toBe(false);
    // Already on (an older fleet): it can still be turned off.
    expect(liveFeedLocked({ ...base, content_capture: true, personal_data: 'exclude' })).toBe(false);
  });

  it('shows the run-label note only for explicit_run', () => {
    expect(carriesOnlyInLabeledRuns({ ...base, handover_carry_forward_effective: 'explicit_run' })).toBe(true);
    expect(carriesOnlyInLabeledRuns({ ...base, handover_carry_forward_effective: 'same_run' })).toBe(false);
    expect(carriesOnlyInLabeledRuns(base)).toBe(false);
  });
});
