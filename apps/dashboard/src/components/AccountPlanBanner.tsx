'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { CLOSING_CHANGED, readClosing } from '@/components/AccountClosingBanner';
import { sharedRead } from '@/lib/shared-read';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Banner, Button } from '@whiteroom/ui';
import { getPlanBanner } from '@/lib/plan-banner';
import { takeItLive } from '@/lib/user-fleets';
import { openBillingPortal } from '@/lib/billing';
import { analytics } from '@/lib/analytics';
import { useViewerZone } from '@/hooks/useViewerZone';
import { useSharedFleetAuth } from '@/hooks/useFleetAuth';
import { SUPPORT_EMAIL } from '@/lib/closing-shared';
import { ROUTES, isUnder } from '@/lib/routes';
import {
  bannerShownOn, GO_LIVE_REFUSED, GOING_LIVE, LIVE_LANDING, LIVE_LINE, NETWORK_LINE, planBannerText, planDay,
  type PlanBannerKind, type PlanState,
} from '@/lib/plan-banner-shared';

/**
 * Fired once going live succeeds, so every plan banner and caveat on the
 * page re-reads at once instead of after PLAN_READ_TTL_MS. useGoLive fires it
 * here; any other caller of takeItLive (the Sandbox verdict) must fire it too.
 */
export const PLAN_CHANGED = 'wr:plan-changed';

/** How long a read of the plan state is reused across pages: it changes rarely, and a change here re-reads at once. */
export const PLAN_READ_TTL_MS = 60_000;
const planRead = sharedRead((fleetId: string | null) => getPlanBanner(fleetId), PLAN_READ_TTL_MS);

/** The account's plan state, shared by the pages opened within PLAN_READ_TTL_MS (per selected fleet). */
export function readPlanState(fleetId: string | null, fresh = false): ReturnType<typeof getPlanBanner> {
  return planRead.get(fleetId, fresh);
}

/** Test hook: forget the shared read. */
export function _forgetPlanRead(): void {
  planRead.forget();
}

/** Going live from here: what the button shows. */
export type GoLiveStatus = { busy: boolean; error: string };

/** /dev previews: a fixed plan state (nothing is read), and optionally the page and a Go live state. */
export const PlanStatePreview = createContext<{ state: PlanState | null; fleetKey?: boolean; goLive?: GoLiveStatus } | null>(null);

/**
 * The plan state for this page: read once the page's fleet session (if any)
 * is known, kept as shown when a read fails, and read again at once on
 * PLAN_CHANGED. Null until known, and when signed out.
 */
export function usePlanState(): PlanState | null {
  const preview = useContext(PlanStatePreview);
  const shared = useSharedFleetAuth();
  const waiting = !preview && shared?.status === 'checking';
  const fleetId = shared?.fleetId ?? null;
  // Kept with the fleet it was read for: another fleet's answer is never shown.
  const [read, setRead] = useState<{ fleetId: string | null; state: PlanState | null } | null>(null);

  useEffect(() => {
    if (preview || waiting) return;
    let current = true;
    let latest: Promise<unknown> | null = null;
    const load = (fresh: boolean) => {
      // Only the latest read lands; an older one finishing late is dropped.
      const asked = readPlanState(fleetId, fresh);
      latest = asked;
      asked.then(
        (v) => { if (current && latest === asked && v !== 'unknown') setRead({ fleetId, state: v }); },
        () => {},
      );
    };
    load(false);
    const changed = () => load(true);
    window.addEventListener(PLAN_CHANGED, changed);
    return () => { current = false; window.removeEventListener(PLAN_CHANGED, changed); };
  }, [preview, waiting, fleetId]);

  if (preview) return preview.state;
  return read && read.fleetId === fleetId ? read.state : null;
}

/** The connect-line caveat for this account, wherever a connect line shows. */
export function useConnectCaveat(): PlanState['caveat'] {
  return usePlanState()?.caveat ?? null;
}

/**
 * Starts the free days from a Go live button: busy while it runs, the
 * refusal or network line on failure (never retried on its own), and on
 * success every plan banner re-reads (PLAN_CHANGED) and the page goes to
 * Fleet key's connect card.
 */
export function useGoLive(where: 'banner' | 'settings', initial?: GoLiveStatus): GoLiveStatus & { goLive: () => void } {
  const [status, setStatus] = useState<GoLiveStatus>(initial ?? { busy: false, error: '' });
  const goLive = useCallback(() => {
    setStatus({ busy: true, error: '' });
    takeItLive(where).then(
      (res) => {
        if (!res.ok) { setStatus({ busy: false, error: GO_LIVE_REFUSED }); return; }
        analytics.capture('take_it_live', { where });
        // The Free banner goes at once, even if the navigation below is slow.
        window.dispatchEvent(new Event(PLAN_CHANGED));
        window.location.assign(LIVE_LANDING);
      },
      () => setStatus({ busy: false, error: NETWORK_LINE }),
    );
  }, [where]);
  return { ...status, goLive };
}

const btn = (variant: 'primary' | 'secondary') => `wr-btn wr-btn--${variant} wr-btn--h32`;

/** Go live's busy label, with the spinner the other busy steps use. */
export const GOING_LIVE_LABEL = <><span className="dx-spin" aria-hidden="true" />{GOING_LIVE}</>;

/** One plan banner as it renders: its words, its one primary action (and Free's second), and its error line. */
export function PlanBannerView({ kind, state, timeZone, fleetKey, goLive, onGoLive, onUpdateCard, cardStatus }: {
  kind: PlanBannerKind;
  state: PlanState;
  timeZone: string;
  /** On Fleet key, Go live is the Free banner's primary action. */
  fleetKey: boolean;
  goLive: GoLiveStatus;
  onGoLive: () => void;
  onUpdateCard: () => void;
  cardStatus: GoLiveStatus;
}) {
  const day = state.date ? planDay(state.date, timeZone) : '';
  let actions: React.ReactNode;
  let error = '';
  if (kind === 'free') {
    const live = <Button key="live" size={32} variant={fleetKey ? 'primary' : 'secondary'} busy={goLive.busy} busyLabel={GOING_LIVE_LABEL} onClick={onGoLive}>Go live</Button>;
    const sandbox = <Link key="sandbox" prefetch={false} href={ROUTES.sandbox} className={btn(fleetKey ? 'secondary' : 'primary')}>Open Sandbox</Link>;
    actions = fleetKey ? [live, sandbox] : [sandbox, live];
    error = goLive.error;
  } else if (kind === 'past_due' || (kind === 'grace' && state.cardFixable !== false)) {
    actions = <Button size={32} variant="primary" busy={cardStatus.busy} busyLabel="Opening…" onClick={onUpdateCard}>Update card</Button>;
    error = cardStatus.error;
  } else {
    const action = state.canBuy ? 'choose_plan' : 'talk_to_us';
    const choose = () => {
      if (kind === 'suspended') analytics.capture('suspended_choose_plan', { action });
      else if (kind === 'grace') analytics.capture('grace_choose_plan', { action });
    };
    actions = state.canBuy
      ? <Link prefetch={false} href={`${ROUTES.settings}#plan`} className={btn('primary')} onClick={choose}>Choose a plan</Link>
      : <a href={`mailto:${SUPPORT_EMAIL}`} className={btn('primary')} onClick={choose}>Talk to us</a>;
  }
  const warn = kind === 'grace' || kind === 'past_due' || kind === 'suspended';
  const banner = (
    <Banner variant={warn ? 'warn' : 'info'} actions={actions}>
      {planBannerText(kind, state.canBuy, day, state.cardFixable !== false)}
      {error && <span role="alert" style={{ display: 'block', color: 'var(--bad)', marginTop: 4 }}>{error}</span>}
    </Banner>
  );
  // The new info banners carry the plan tint (globals.css); warn banners stay as they are.
  return <div className={warn ? undefined : 'wr-plan-banner'}>{banner}</div>;
}

/**
 * Whether today's closing banner is showing (it comes first): the same
 * shared read it makes, again at once when it changes. Null until the first
 * read settles, so no plan banner flashes before a closing one. An unknown
 * or failed read keeps the last answer (not closing, the first time).
 */
function useClosingShown(skip: boolean): boolean | null {
  const [closing, setClosing] = useState<boolean | null>(skip ? false : null);
  useEffect(() => {
    if (skip) return;
    let current = true;
    const settle = (v: boolean | null) => { if (current) setClosing((was) => v ?? was ?? false); };
    const load = (fresh: boolean) => readClosing(fresh).then((v) => settle(v === 'unknown' ? null : v !== null), () => settle(null));
    load(false);
    const changed = () => load(true);
    window.addEventListener(CLOSING_CHANGED, changed);
    return () => { current = false; window.removeEventListener(CLOSING_CHANGED, changed); };
  }, [skip]);
  return closing;
}

/**
 * Every signed-in page: the account's one plan banner (Free, trial ending,
 * Suspended, card failed, grace), in the closing banner's slot and only when
 * that one isn't showing. Not on Settings, and on Sandbox only the
 * card-failed ones. None while the page shows a paid organization's fleet.
 */
export function AccountPlanBanner() {
  const preview = useContext(PlanStatePreview);
  const state = usePlanState();
  const pathname = usePathname() ?? '';
  const timeZone = useViewerZone() || 'UTC';
  const live = useGoLive('banner', preview?.goLive);
  const [card, setCard] = useState<GoLiveStatus>({ busy: false, error: '' });
  const closing = useClosingShown(!!preview);

  const kind = state?.banner;
  if (!state || !kind || closing !== false || !bannerShownOn(kind, pathname)) return null;

  async function updateCard() {
    setCard({ busy: true, error: '' });
    try {
      const res = await openBillingPortal();
      if (res.ok) { window.location.href = res.url; return; }
      setCard({ busy: false, error: res.error });
    } catch {
      setCard({ busy: false, error: NETWORK_LINE });
    }
  }

  return (
    <div style={{ padding: '12px 16px 0' }} data-testid="account-plan-banner">
      <PlanBannerView
        kind={kind}
        state={state}
        timeZone={timeZone}
        fleetKey={preview?.fleetKey ?? isUnder(pathname, ROUTES.fleetKey)}
        goLive={live}
        onGoLive={live.goLive}
        onUpdateCard={() => void updateCard()}
        cardStatus={card}
      />
    </div>
  );
}

/**
 * Fleet key, on arrival after going live (once: the page drops ?live=1):
 * when the free days end, and what to do next. Focus moves to it, so a
 * screen reader hears it first; the Banner itself is unchanged.
 */
export function YoureLive({ trialEndsAt }: { trialEndsAt: string }) {
  const timeZone = useViewerZone() || 'UTC';
  const [wrap, setWrap] = useState<HTMLDivElement | null>(null);
  // Focus without the browser's jump, then bring the line to the top: the connect card follows it.
  useEffect(() => {
    if (!wrap) return;
    wrap.focus({ preventScroll: true });
    wrap.scrollIntoView?.({ block: 'start' });
  }, [wrap]);
  return (
    <div className="wr-plan-banner" tabIndex={-1} ref={setWrap} data-testid="youre-live">
      <Banner variant="info" icon="check">{LIVE_LINE(planDay(trialEndsAt, timeZone))}</Banner>
    </div>
  );
}

/**
 * Fleet key: whether the page was opened by going live (?live=1). The flag is
 * dropped from the address at once (the hash kept), so a reload doesn't show
 * the one-time line again.
 */
export function useArrivedLive(): boolean {
  const [arrived, setArrived] = useState(false);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get('live') !== '1') return;
    setArrived(true);
    url.searchParams.delete('live');
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  }, []);
  return arrived;
}
