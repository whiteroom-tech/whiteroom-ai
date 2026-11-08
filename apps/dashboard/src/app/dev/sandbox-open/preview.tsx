'use client';

import { SkeletonCard } from '@whiteroom/ui';
import { AppShell } from '@/components/AppShell';
import { PageHeader } from '@/components/citadel/PageChrome';
import { LoadFailed } from '@/components/citadel/States';
import { SandboxClearedLine } from '@/components/sandbox/HomeFleetLines';
import { SandboxOpensLater } from '@/components/sandbox/SandboxEntry';
import { SandboxHome } from '@/components/sandbox/v2/SandboxHome';
import { SANDBOX_OPEN_FAILED, SANDBOX_OPENING } from '@/lib/home-fleet-shared';
import s from '@/components/sandbox/guided.module.css';
import { SANDBOX_V2_STATES } from '../sandbox-v2/states';
import type { SandboxOpenState } from './states';

/** An open time on the viewer's clock: two hours from now (capped at 23:30 so it stays today), or tomorrow at 05:30. */
function opensAt(tomorrow: boolean): string {
  const d = new Date();
  if (tomorrow) { d.setDate(d.getDate() + 1); d.setHours(5, 30, 0, 0); return d.toISOString(); }
  const later = new Date(d.getTime() + 2 * 3_600_000);
  if (later.getDate() !== d.getDate()) d.setHours(23, 30, 0, 0); else d.setTime(later.getTime());
  return d.toISOString();
}

// Renders as a signed-in user without a real session: nothing is fetched or changed.
export function SandboxOpenPreview({ state }: { state: SandboxOpenState }) {
  const shell = (body: React.ReactNode) => <>
    <PageHeader title="Sandbox" />
    <main className={s.content}>{body}</main>
  </>;
  return (
    <AppShell>
      {state === 'opening' && shell(<SkeletonCard label={SANDBOX_OPENING} style={{ maxWidth: 480 }} />)}
      {state === 'failed' && shell(<div style={{ maxWidth: 480 }}><LoadFailed what="your Sandbox" text={SANDBOX_OPEN_FAILED} onRetry={() => {}} /></div>)}
      {(state === 'opens-later' || state === 'opens-tomorrow') && <SandboxOpensLater opensAt={opensAt(state === 'opens-tomorrow')} />}
      {state === 'cleared' && <SandboxHome fleet="home-preview" preview={SANDBOX_V2_STATES['not-connected']} planLine={<SandboxClearedLine />} />}
    </AppShell>
  );
}
