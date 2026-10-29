'use client';

import { AppShell } from '@/components/AppShell';
import { SandboxHome } from '@/components/sandbox/v2/SandboxHome';
import { SANDBOX_V2_STATES, type SandboxV2State } from './states';

// Renders as a signed-in user without a real session: nothing is fetched or
// changed, and Connect / Rotate / Reset only change the page.
export function SandboxV2Preview({ state }: { state: SandboxV2State }) {
  return (
    <AppShell>
      <SandboxHome key={state} fleet="prod-eu" preview={SANDBOX_V2_STATES[state]} />
    </AppShell>
  );
}
