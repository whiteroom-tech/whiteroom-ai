'use client';

import { AppShell } from '@/components/AppShell';
import { PageHeader } from '@/components/citadel/PageChrome';
import { PlanBannerView, YoureLive } from '@/components/AccountPlanBanner';
import { useViewerZone } from '@/hooks/useViewerZone';
import { PLAN_PREVIEWS } from './states';

const idle = { busy: false, error: '' };

/** /dev/plan-banners: each banner in its slot, as on Home (and Free as on Fleet key). */
export function PlanBannersPreview() {
  const timeZone = useViewerZone() || 'UTC';
  const rows = Object.entries(PLAN_PREVIEWS).flatMap(([name, p]) => {
    if (!p.state.banner) return [];
    const one = (fleetKey: boolean) => (
      <section key={`${name}-${fleetKey}`} data-state={name} style={{ display: 'grid', gap: 6 }}>
        <div style={{ padding: '0 16px', fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>{p.label}{fleetKey ? ' · on Fleet key' : ''}</div>
        <div style={{ padding: '0 16px' }}>
          <PlanBannerView kind={p.state.banner!} state={p.state} timeZone={timeZone} fleetKey={fleetKey} goLive={p.goLive ?? idle} onGoLive={() => {}} onUpdateCard={() => {}} cardStatus={idle} />
        </div>
      </section>
    );
    return name === 'free' ? [one(false), one(true)] : [one(false)];
  });
  return (
    <AppShell>
      <PageHeader title="Plan banners" />
      <main style={{ flex: 1, overflow: 'auto', minHeight: 0, display: 'grid', gap: 20, alignContent: 'start', padding: '16px 0 32px' }}>
        {rows}
        <section data-state="live" style={{ display: 'grid', gap: 6 }}>
          <div style={{ padding: '0 16px', fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>{PLAN_PREVIEWS.live.label} · Fleet key</div>
          <div style={{ padding: '0 16px' }}><YoureLive trialEndsAt={PLAN_PREVIEWS.live.state.trialEndsAt!} /></div>
        </section>
      </main>
    </AppShell>
  );
}
