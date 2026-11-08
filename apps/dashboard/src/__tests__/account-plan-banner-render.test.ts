// @vitest-environment happy-dom
// On screen: the plan banner's words and buttons per state (one primary,
// Choose a plan or Talk to us, never both), the info fill only on the new
// info banners, Go live busy and failed, where it hides, PLAN_CHANGED, and
// Fleet key's caveats and one-time "You're live" line.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  path: '/home',
  state: null as import('@/lib/plan-banner-shared').PlanState | null | 'unknown',
  reads: [] as (string | null | undefined)[],
  takeItLive: vi.fn(),
  portal: vi.fn(),
  capture: vi.fn(),
  shared: null as { status: string; fleetId: string | null } | null,
  closing: null as unknown,
  hold: null as Promise<void> | null,
  closingHold: null as Promise<void> | null,
}));
vi.mock('next/navigation', () => ({ usePathname: () => api.path, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/lib/plan-banner', () => ({ getPlanBanner: async (fleetId?: string | null) => { api.reads.push(fleetId); const s = api.state; if (api.hold) await api.hold; return s; } }));
vi.mock('@/lib/account', () => ({ getAccountClosing: async () => { if (api.closingHold) await api.closingHold; return api.closing; }, cancelAccountDeletion: vi.fn() }));
vi.mock('@/lib/user-fleets', () => ({ takeItLive: api.takeItLive }));
vi.mock('@/lib/billing', () => ({ openBillingPortal: api.portal, startCheckout: vi.fn() }));
vi.mock('@/lib/analytics', () => ({ analytics: { capture: api.capture, identify: vi.fn() }, initAnalytics: vi.fn() }));
vi.mock('@/hooks/useFleetAuth', () => ({ useSharedFleetAuth: () => api.shared }));

const { AccountPlanBanner, PlanBannerView, PLAN_CHANGED, _forgetPlanRead, YoureLive, useArrivedLive } = await import('@/components/AccountPlanBanner');
const { ConnectCaveat } = await import('@/components/ConnectCaveat');
const { CLOSING_CHANGED, _forgetClosingRead } = await import('@/components/AccountClosingBanner');
const { PLAN_BANNER_ORDER } = await import('@/lib/plan-banner-shared');

const roots: import('react-dom/client').Root[] = [];
const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
async function mount(node: React.ReactElement) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);
  await act(async () => { root.render(node); });
  await flush();
  const buttons = () => [...el.querySelectorAll<HTMLElement>('button, a')];
  const find = (label: string) => buttons().find((b) => b.textContent?.trim() === label);
  const click = async (b: HTMLElement) => { await act(async () => { b.click(); }); await flush(); };
  return { el, root, text: () => el.textContent ?? '', buttons, find, click };
}
const state = (banner: import('@/lib/plan-banner-shared').PlanBannerKind | null, more: Partial<import('@/lib/plan-banner-shared').PlanState> = {}) =>
  ({ banner, date: '2026-12-08T12:00:00Z', canBuy: true, cardFixable: true, caveat: null, trialEndsAt: null, ...more });
const idle = { busy: false, error: '' };
const view = (kind: import('@/lib/plan-banner-shared').PlanBannerKind, more: Record<string, unknown> = {}) => h(PlanBannerView, {
  kind, timeZone: 'UTC', fleetKey: false, goLive: idle, onGoLive: () => {}, onUpdateCard: () => {}, cardStatus: idle, ...more, state: state(kind, (more.state as object) ?? {}),
});
const primaries = (el: HTMLElement) => el.querySelectorAll('.wr-btn--primary').length;

let assign: ReturnType<typeof vi.fn>;
beforeEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  _forgetPlanRead();
  _forgetClosingRead();
  api.closing = null;
  api.hold = null;
  api.closingHold = null;
  api.path = '/home';
  api.state = null;
  api.reads = [];
  api.shared = null;
  api.takeItLive.mockReset();
  api.portal.mockReset();
  api.capture.mockReset();
  document.body.innerHTML = '';
  assign = vi.fn();
  Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, assign, href: 'http://localhost/home' } });
});

describe('each banner', () => {
  it('has exactly one primary action, at 32 px', async () => {
    for (const kind of PLAN_BANNER_ORDER) {
      for (const canBuy of [true, false]) {
        const m = await mount(view(kind, { state: { canBuy } }));
        expect(primaries(m.el)).toBe(1);
        expect(m.el.querySelectorAll('.wr-btn--h28')).toHaveLength(0);
        expect(m.el.querySelectorAll('.wr-btn').length).toBe(m.el.querySelectorAll('.wr-btn--h32').length);
      }
      const fk = await mount(view(kind, { fleetKey: true }));
      expect(primaries(fk.el)).toBe(1);
    }
  });

  it('Free: Open Sandbox primary and Go live secondary; on Fleet key the other way round', async () => {
    const m = await mount(view('free'));
    expect(m.text()).toContain("You're on Free. Your 30 free days start when you take an agent live.");
    expect(m.find('Open Sandbox')?.className).toContain('wr-btn--primary');
    expect(m.find('Open Sandbox')?.getAttribute('href')).toBe('/sandbox');
    expect(m.find('Go live')?.className).toContain('wr-btn--secondary');
    const fk = await mount(view('free', { fleetKey: true }));
    expect(fk.find('Go live')?.className).toContain('wr-btn--primary');
    expect(fk.find('Open Sandbox')?.className).toContain('wr-btn--secondary');
    expect(fk.buttons().map((b) => b.textContent)).toEqual(['Go live', 'Open Sandbox']);
  });

  it('Suspended and trial ending: Choose a plan, or Talk to us when nothing can be bought, never both, matching the words', async () => {
    for (const kind of ['suspended', 'trial_ending'] as const) {
      const buy = await mount(view(kind));
      expect(buy.find('Choose a plan')?.getAttribute('href')).toBe('/settings#plan');
      expect(buy.find('Talk to us')).toBeUndefined();
      expect(buy.text()).toContain('Choose a plan to');
      const talk = await mount(view(kind, { state: { canBuy: false } }));
      expect(talk.find('Talk to us')?.getAttribute('href')).toBe('mailto:info@whiteroom.tech');
      expect(talk.find('Choose a plan')).toBeUndefined();
      expect(talk.text()).toContain('Talk to us to');
      expect(talk.text()).not.toContain('Choose a plan');
    }
    const t = await mount(view('trial_ending'));
    expect(t.text()).toContain('Your free days end on Dec 8.');
  });

  it('grace and past-due: Update card opens the billing portal', async () => {
    const onUpdateCard = vi.fn();
    const m = await mount(view('grace', { onUpdateCard }));
    expect(m.text()).toContain('Your plan switches off on Dec 8 because a payment failed. Update your card to keep it.');
    await m.click(m.find('Update card')!);
    expect(onUpdateCard).toHaveBeenCalledOnce();
    expect((await mount(view('past_due'))).text()).toContain('Your card payment failed. Update your card to keep your plan.Update card');
  });

  it('grace after Stripe cancelled the subscription: Choose a plan (or Talk to us), not Update card, with matching words', async () => {
    const buy = await mount(view('grace', { state: { cardFixable: false } }));
    expect(buy.text()).toContain('Your plan switches off on Dec 8 because a payment failed. Choose a plan to keep it.');
    expect(buy.find('Choose a plan')?.getAttribute('href')).toBe('/settings#plan');
    expect(buy.find('Update card')).toBeUndefined();
    expect(primaries(buy.el)).toBe(1);
    const talk = await mount(view('grace', { state: { cardFixable: false, canBuy: false } }));
    expect(talk.text()).toContain('because a payment failed. Talk to us to keep it.');
    expect(talk.find('Talk to us')?.getAttribute('href')).toBe('mailto:info@whiteroom.tech');
    expect(talk.find('Choose a plan')).toBeUndefined();
  });

  it('a state without cardFixable (an older server during a deploy) keeps Update card', async () => {
    const st = { ...state('grace') } as Record<string, unknown>;
    delete st.cardFixable;
    const m = await mount(h(PlanBannerView, { kind: 'grace', state: st as never, timeZone: 'UTC', fleetKey: false, goLive: idle, onGoLive: () => {}, onUpdateCard: () => {}, cardStatus: idle }));
    expect(m.find('Update card')).toBeDefined();
    expect(m.text()).toContain('Update your card to keep it.');
  });

  it('grace Choose a plan is counted', async () => {
    api.state = state('grace', { cardFixable: false });
    const m = await mount(h(AccountPlanBanner));
    await m.click(m.find('Choose a plan')!);
    expect(api.capture).toHaveBeenCalledWith('grace_choose_plan', { action: 'choose_plan' });
  });

  it('the info fill only on the new info banners (Free, trial ending); warn banners as they are', async () => {
    for (const kind of PLAN_BANNER_ORDER) {
      const m = await mount(view(kind));
      const info = kind === 'free' || kind === 'trial_ending';
      expect(m.el.querySelector('.wr-plan-banner .wr-banner')).toBe(info ? m.el.querySelector('.wr-banner') : null);
      expect(m.el.querySelector('.wr-banner')?.className).toBe(info ? 'wr-banner wr-banner--info' : 'wr-banner wr-banner--warn');
    }
  });

  it('Go live busy reads "Going live…", disabled; a failure line sits in the body with role="alert" on it only', async () => {
    const busy = await mount(view('free', { goLive: { busy: true, error: '' } }));
    const b = busy.buttons().find((x) => x.textContent === 'Going live…') as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    const failed = await mount(view('free', { goLive: { busy: false, error: "Couldn't go live. Try again." } }));
    const alerts = failed.el.querySelectorAll('[role="alert"]');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].textContent).toBe("Couldn't go live. Try again.");
    expect(alerts[0].closest('.wr-banner__body')).not.toBeNull();
    expect(failed.el.querySelector('.wr-banner')?.getAttribute('role')).toBe('status');
  });
});

describe('AccountPlanBanner', () => {
  it('shows the account\'s banner, and nothing when there is none', async () => {
    api.state = state(null);
    expect((await mount(h(AccountPlanBanner))).el.querySelector('[data-testid="account-plan-banner"]')).toBeNull();
    _forgetPlanRead();
    api.state = state('free');
    expect((await mount(h(AccountPlanBanner))).text()).toContain("You're on Free.");
  });

  it('hidden on Settings; on Sandbox only the card-failed ones show', async () => {
    api.state = state('free');
    api.path = '/settings';
    expect((await mount(h(AccountPlanBanner))).text()).toBe('');
    api.path = '/sandbox';
    expect((await mount(h(AccountPlanBanner))).text()).toBe('');
    _forgetPlanRead();
    api.state = state('past_due');
    expect((await mount(h(AccountPlanBanner))).text()).toContain('Your card payment failed.');
  });

  it('waits for the page\'s fleet session, then reads for that fleet', async () => {
    api.state = state('free');
    api.shared = { status: 'checking', fleetId: null };
    const m = await mount(h(AccountPlanBanner));
    expect(api.reads).toEqual([]);
    api.shared = { status: 'authenticated', fleetId: 'org-fleet' };
    await act(async () => { m.root.render(h(AccountPlanBanner)); });
    await flush();
    expect(api.reads).toEqual(['org-fleet']);
  });

  it('Go live: busy, then a full load of Fleet key\'s connect card (no PLAN_CHANGED re-reads first); the event is captured', async () => {
    api.state = state('free');
    let resolve!: (v: unknown) => void;
    api.takeItLive.mockReturnValue(new Promise((r) => { resolve = r; }));
    const changed = vi.fn();
    window.addEventListener(PLAN_CHANGED, changed);
    const m = await mount(h(AccountPlanBanner));
    await m.click(m.find('Go live')!);
    expect(api.takeItLive).toHaveBeenCalledWith('banner');
    expect(m.text()).toContain('Going live…');
    await act(async () => { resolve({ ok: true, trialEndsAt: '2026-12-08T12:00:00Z' }); });
    await flush();
    expect(changed).not.toHaveBeenCalled();
    expect(assign).toHaveBeenCalledWith('/fleet-key?live=1#point');
    expect(api.capture).toHaveBeenCalledWith('take_it_live', { where: 'banner' });
    window.removeEventListener(PLAN_CHANGED, changed);
  });

  it('Go live refused says so; a network failure keeps today\'s line; neither retries', async () => {
    api.state = state('free');
    api.takeItLive.mockResolvedValue({ ok: false });
    const m = await mount(h(AccountPlanBanner));
    await m.click(m.find('Go live')!);
    expect(m.el.querySelector('[role="alert"]')?.textContent).toBe("Couldn't go live. Try again.");
    api.takeItLive.mockRejectedValue(new Error('offline'));
    await m.click(m.find('Go live')!);
    expect(m.el.querySelector('[role="alert"]')?.textContent).toBe('That didn’t work. Check your connection and try again.');
    expect(api.takeItLive).toHaveBeenCalledTimes(2);
    expect(assign).not.toHaveBeenCalled();
  });

  it('none while the closing banner shows, and back at once when the deletion is cancelled', async () => {
    api.state = state('free');
    api.closing = { reason: 'deleted', closesAt: new Date(Date.now() + 86_400_000).toISOString() };
    const m = await mount(h(AccountPlanBanner));
    expect(m.text()).toBe('');
    api.closing = null;
    await act(async () => { window.dispatchEvent(new Event(CLOSING_CHANGED)); });
    await flush();
    expect(m.text()).toContain("You're on Free.");
  });

  it('shows nothing until the closing read settles, so it never flashes before a closing banner', async () => {
    api.state = state('free');
    let release!: () => void;
    api.closingHold = new Promise((r) => { release = r; });
    const m = await mount(h(AccountPlanBanner));
    expect(m.text()).toBe('');
    await act(async () => { release(); });
    await flush();
    expect(m.text()).toContain("You're on Free.");
  });

  it('a switch of fleet never shows the old fleet\'s answer, even when it lands late', async () => {
    api.state = state('free');
    api.shared = { status: 'authenticated', fleetId: 'own' };
    let release!: () => void;
    api.hold = new Promise((r) => { release = r; });
    const m = await mount(h(AccountPlanBanner));
    // The own fleet's read is still out; the page moves to an org fleet whose answer is no banner.
    api.hold = null;
    api.state = state(null);
    api.shared = { status: 'authenticated', fleetId: 'org-fleet' };
    await act(async () => { m.root.render(h(AccountPlanBanner)); });
    await flush();
    await act(async () => { release(); });
    await flush();
    expect(m.text()).toBe('');
  });

  it('PLAN_CHANGED re-reads at once, past the 60 s reuse', async () => {
    api.state = state('free');
    const m = await mount(h(AccountPlanBanner));
    expect(m.text()).toContain("You're on Free.");
    api.state = state(null);
    await act(async () => { window.dispatchEvent(new Event(PLAN_CHANGED)); });
    await flush();
    expect(m.text()).toBe('');
    expect(api.reads).toHaveLength(2);
  });

  it('a read that fails keeps what was shown', async () => {
    api.state = state('free');
    const m = await mount(h(AccountPlanBanner));
    api.state = 'unknown';
    await act(async () => { window.dispatchEvent(new Event(PLAN_CHANGED)); });
    await flush();
    expect(m.text()).toContain("You're on Free.");
  });

  it('Suspended Choose a plan is counted', async () => {
    api.state = state('suspended');
    const m = await mount(h(AccountPlanBanner));
    await m.click(m.find('Choose a plan')!);
    expect(api.capture).toHaveBeenCalledWith('suspended_choose_plan', { action: 'choose_plan' });
  });

  it('Update card goes to the portal, or says why not', async () => {
    api.state = state('grace');
    api.portal.mockResolvedValue({ ok: false, error: 'Could not open the billing portal.' });
    const m = await mount(h(AccountPlanBanner));
    await m.click(m.find('Update card')!);
    expect(m.el.querySelector('[role="alert"]')?.textContent).toBe('Could not open the billing portal.');
  });
});

describe('Fleet key', () => {
  it('caveats: Free and Suspended words, nothing otherwise', async () => {
    expect((await mount(h(ConnectCaveat, { caveat: 'free' }))).text()).toBe('This line works once you go live.');
    expect((await mount(h(ConnectCaveat, { caveat: 'suspended' }))).text()).toBe('This line works again once you choose a plan.');
    expect((await mount(h(ConnectCaveat, { caveat: null }))).text()).toBe('');
  });

  it('"You\'re live": the end date, the check icon, the info fill, and focus on its wrapper', async () => {
    const m = await mount(h(YoureLive, { trialEndsAt: '2026-12-08T12:00:00Z' }));
    expect(m.text()).toBe("You're live. Your 30 free days end on Dec 8. Put the line below in your .env.");
    const wrap = m.el.querySelector('[data-testid="youre-live"]') as HTMLElement;
    expect(wrap.className).toBe('wr-plan-banner');
    expect(wrap.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(wrap);
    expect(m.el.querySelector('.wr-banner')?.className).toBe('wr-banner wr-banner--info');
  });
});

describe('Home with no agents', () => {
  it('adds "This line works once you go live." under the connect line on Free only', async () => {
    const { EmptyHome } = await import('@/components/home/EmptyHome');
    api.state = state('free', { caveat: 'free' });
    expect((await mount(h(EmptyHome))).text()).toContain('This line works once you go live.');
    _forgetPlanRead();
    api.state = state(null);
    const paid = await mount(h(EmptyHome));
    expect(paid.text()).toContain('No agents connected yet');
    expect(paid.text()).not.toContain('This line works');
  });
});

describe('Fleet key arrival from going live', () => {
  function Probe() { return h('span', null, useArrivedLive() ? 'live' : 'plain'); }
  it('shows the line only with ?live=1, then drops the flag and keeps #point', async () => {
    const replace = vi.spyOn(window.history, 'replaceState');
    Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, href: 'http://localhost/fleet-key?live=1#point' } });
    expect((await mount(h(Probe))).text()).toBe('live');
    expect(replace).toHaveBeenCalledWith(window.history.state, '', '/fleet-key#point');
    replace.mockClear();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, href: 'http://localhost/fleet-key#point' } });
    expect((await mount(h(Probe))).text()).toBe('plain');
    expect(replace).not.toHaveBeenCalled();
    replace.mockRestore();
  });
});
