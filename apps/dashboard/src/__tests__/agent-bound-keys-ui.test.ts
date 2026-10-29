// Keys made for one agent (engine #311): the key list says which agent, and
// both Stop confirmations explain how a shared key lets a stopped agent go on.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SHARED_KEY_STOP_NOTE } from '@/lib/setup';

import { keyScopeLabel } from '@/lib/provider-key-form';

describe('keys for one agent', () => {
  it('labels a key made for one agent, and not a fleet-wide one', () => {
    expect(keyScopeLabel({ agentId: 'claims-triage' })).toBe('only for claims-triage');
    expect(keyScopeLabel({})).toBeNull();
  });

  it('the key list uses that label', () => {
    const src = readFileSync(join(__dirname, '..', 'app/fleet-key/onboarding.tsx'), 'utf8');
    expect(src).toContain('{keyScopeLabel(k)}');
  });

  it('puts the shared-key note on both Stop confirmations', () => {
    expect(SHARED_KEY_STOP_NOTE).toContain('Fleet key page');
    for (const file of ['components/home/AgentActions.tsx', 'components/agent/AgentDetail.tsx']) {
      const src = readFileSync(join(__dirname, '..', file), 'utf8');
      const stopDialog = src.slice(src.indexOf('confirmLabel="Stop agent"') - 600, src.indexOf('confirmLabel="Stop agent"'));
      expect(stopDialog, file).toContain('{SHARED_KEY_STOP_NOTE}');
    }
  });
});
