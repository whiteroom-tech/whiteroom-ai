// @vitest-environment happy-dom
// Free tier on the Sandbox (spec Part 1 §3.1, §3.5–§3.7, §3.10, §5; Part 2
// §10.6): the Free / invite / 7-day reset lines, the verdict's Take it live
// and Suspended's Choose a plan, the Sandbox's refusal codes in §3.10's words
// with reset times in the viewer's zone, quiet retries of busy reads, and a
// non-Free account's page unchanged. Placeholder keys only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const getSandboxPlan = vi.hoisted(() => vi.fn());
const takeItLive = vi.hoisted(() => vi.fn());
vi.mock('@/lib/sandbox/sandbox-plan', () => ({ getSandboxPlan }));
vi.mock('@/lib/user-fleets', () => ({ takeItLive }));
// The plan banner's event name only (the banner itself reads the server).
vi.mock('@/components/AccountPlanBanner', () => ({ PLAN_CHANGED: 'wr:plan-changed' }));
// The BFF module's sign-in: never used by refusalResponse.
vi.mock('@/auth', () => ({ auth: async () => null }));
const capture = vi.hoisted(() => vi.fn());
vi.mock('@/lib/analytics', () => ({ analytics: { capture } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { SandboxHome } = await import('@/components/sandbox/v2/SandboxHome');
const { PLAN_CHANGED } = await import('@/components/AccountPlanBanner');
const { SANDBOX_V2_STATES } = await import('@/app/dev/sandbox-v2/states');
const R = await import('@/lib/sandbox/refusals');
const { sandboxPlanLine, OTHER_PLAN } = await import('@/lib/sandbox/plan-view');
const { engineBody, refusalResponse } = await import('@/lib/sandbox/fleet-server');
const { statusOf, sampleRefusalOf, SandboxFleetError } = await import('@/lib/sandbox/fleet');
const { checkStateOf } = await import('@/lib/sandbox/checks');
const { endedBecause } = await import('@/lib/sandbox/practice/model');
const { PracticeError, refusalText } = await import('@/lib/sandbox/practice/api');
const { failedCallsOf } = await import('@/lib/sandbox/failed-calls');
const { PLANS } = await import('@/lib/plans');

/** §3.10's words are written with straight quotes; the dashboard sets them with curly ones. */
const plain = (s: string | null | undefined) => (s ?? '').replace(/[’‘]/g, "'");

// 15:00 UTC: 00:00 UTC is 8:00 PM the same day in New York (EDT), 5:30 AM the next day in Kolkata.
const NOW = Date.parse('2026-10-29T15:00:00Z');
const RESET = '2026-10-30T00:00:00.000Z';
const NY = 'America/New_York';
const KOL = 'Asia/Kolkata';

describe('§3.10: the Sandbox refusal codes in the dashboard’s words', () => {
  it('reset times are in the viewer’s zone, with "tomorrow at" on their next calendar day, never 00:00 UTC', () => {
    expect(R.resetWords(RESET, NOW, NY)).toBe('at 8:00 PM your time');
    expect(R.resetWords(RESET, NOW, KOL)).toBe('tomorrow at 5:30 AM your time');
    // Missing, unreadable or already past: the next 00:00 UTC after now.
    expect(R.resetWords(null, NOW, NY)).toBe('at 8:00 PM your time');
    expect(R.resetWords('soon', NOW, NY)).toBe('at 8:00 PM your time');
    expect(R.resetWords('2026-10-01T00:00:00Z', NOW, NY)).toBe('at 8:00 PM your time');
    // UTC itself: the reset is the next day's midnight.
    expect(R.resetWords(RESET, NOW, 'UTC')).toBe('tomorrow at 12:00 AM your time');
  });

  it('each line, word for word (both day variants)', () => {
    expect(plain(R.sampleLimitLine(RESET, NOW, NY))).toBe("You've used today's sample runs. More at 8:00 PM your time, or use your own key now.");
    expect(plain(R.sampleLimitLine(RESET, NOW, KOL))).toBe("You've used today's sample runs. More tomorrow at 5:30 AM your time, or use your own key now.");
    expect(plain(R.practiceLimitLine(RESET, NOW, NY))).toBe("You've used today's practice runs. You can start more at 8:00 PM your time.");
    expect(plain(R.practiceLimitLine(RESET, NOW, KOL))).toBe("You've used today's practice runs. You can start more tomorrow at 5:30 AM your time.");
    expect(plain(R.callsLimitLine(RESET, NOW, NY))).toBe("Your Sandbox hit today's limit of 1,000 calls. It takes calls again at 8:00 PM your time.");
    expect(plain(R.callsLimitLine(RESET, NOW, KOL))).toBe("Your Sandbox hit today's limit of 1,000 calls. It takes calls again tomorrow at 5:30 AM your time.");
    expect(plain(R.FREE_PAUSED_LINE)).toBe("Sandbox isn't taking new runs right now. Nothing you set up is lost. Try again later.");
    expect(plain(R.FREE_PAUSED_STOPPED)).toBe("Stopped: Sandbox isn't taking runs right now. Run it again later.");
    expect(R.SANDBOX_BUSY_LINE).toBe('Sandbox is busy. Try again in a moment.');
    expect(plain(R.DB_UNAVAILABLE_LINE)).toBe("Sandbox can't take calls right now. Try again in a moment.");
    expect(R.SAMPLE_BUDGET_LINE).toBe('Our sample agent is done for today. You can still use your own key.');
    expect(plain(R.NETWORK_LINE)).toBe("That didn't work. Check your connection and try again.");
  });

  it('maps every code (and today’s 429 reasons) to its words; anything else keeps today’s message', () => {
    const w = (r: Parameters<typeof R.refusalWords>[0], what: Parameters<typeof R.refusalWords>[1] = 'other') => plain(R.refusalWords(r, what, NOW, NY));
    expect(w({ status: 402, code: 'sandbox_daily_limit', resetAt: RESET }, 'sample')).toContain('sample runs. More at 8:00 PM');
    expect(w({ status: 429, reason: 'limit_fleet', code: 'sandbox_daily_limit', resetAt: RESET }, 'sample')).toContain('sample runs. More at 8:00 PM');
    expect(w({ status: 429, reason: 'limit_fleet' }, 'sample')).toContain('sample runs. More at 8:00 PM');
    expect(w({ status: 429, reason: 'limit_global' }, 'sample')).toBe(R.SAMPLE_BUDGET_LINE);
    expect(w({ status: 503, code: 'sample_budget_exhausted' }, 'sample')).toBe(R.SAMPLE_BUDGET_LINE);
    expect(w({ status: 429, reason: 'starts_today' }, 'practice')).toContain('practice runs. You can start more at 8:00 PM');
    expect(w({ status: 402, code: 'sandbox_daily_limit' }, 'calls')).toContain('limit of 1,000 calls');
    expect(w({ status: 503, code: 'free_paused' })).toBe(plain(R.FREE_PAUSED_LINE));
    for (const code of ['sandbox_busy', 'control_busy', 'cleanup_busy']) expect(w({ status: 503, code })).toBe(R.SANDBOX_BUSY_LINE);
    expect(w({ status: 503, code: 'db_unavailable' })).toBe(plain(R.DB_UNAVAILABLE_LINE));
    // A daily limit with no surface named: the caller keeps the message.
    expect(R.refusalWords({ status: 402, code: 'sandbox_daily_limit' }, 'other', NOW)).toBeNull();
    expect(R.refusalWords({ status: 409, reason: 'busy' }, 'sample', NOW)).toBeNull();
    expect(R.refusalWords({ status: 409, reason: 'connected' }, 'sample', NOW)).toBeNull();
  });

  it('the BFF passes the code, resetAt and wait on; a 5xx Sandbox code gets §3.10’s words and keeps its 503; anything else stays generic', async () => {
    const limit = refusalResponse(429, { error: 'You’ve used today’s sample runs. Try again tomorrow, or use your own key.', reason: 'limit_fleet', code: 'sandbox_daily_limit', resetAt: RESET }, '32400');
    expect(limit.status).toBe(429);
    expect(limit.headers.get('Retry-After')).toBe('32400');
    expect(await limit.json()).toEqual({ error: 'You’ve used today’s sample runs. Try again tomorrow, or use your own key.', reason: 'limit_fleet', code: 'sandbox_daily_limit', resetAt: RESET, retryAfter: 32400 });
    const paused = refusalResponse(503, { error: 'whatever the engine says', reason: 'free_paused', code: 'free_paused', whiteroom: { reason: 'free_paused', forwarded: false } }, '60');
    expect(paused.status).toBe(503);
    expect(await paused.json()).toEqual({ error: R.FREE_PAUSED_LINE, reason: 'free_paused', code: 'free_paused', retryAfter: 60 });
    const busy = refusalResponse(503, { error: 'x', whiteroom: { reason: 'sandbox_busy', forwarded: false } }, null);
    expect(await busy.json()).toEqual({ error: R.SANDBOX_BUSY_LINE, reason: 'sandbox_busy', code: 'sandbox_busy' });
    // The code as the refusal's own reason.
    expect(await refusalResponse(503, { error: 'x', reason: 'sandbox_busy' }, null).json()).toEqual({ error: R.SANDBOX_BUSY_LINE, reason: 'sandbox_busy', code: 'sandbox_busy' });
    expect(await refusalResponse(503, { error: 'x', reason: 'free_paused' }, null).json()).toEqual({ error: R.FREE_PAUSED_LINE, reason: 'free_paused', code: 'free_paused' });
    const other = refusalResponse(503, { error: 'Couldn’t start the sample right now.', reason: 'sandbox' }, '5');
    expect(other.status).toBe(503);
    expect(await other.json()).toEqual({ error: 'The Sandbox couldn’t do that right now. Try again in a moment.' });
    // A resetAt that isn't an ISO time, or on a code that isn't a daily limit, is dropped; unknown codes too.
    expect(await refusalResponse(402, { error: 'x', code: 'sandbox_daily_limit', resetAt: 'tomorrow' }, null).json()).toEqual({ error: 'x', code: 'sandbox_daily_limit' });
    expect(await refusalResponse(400, { error: 'x', code: 'made_up', resetAt: RESET }, null).json()).toEqual({ error: 'x' });
  });

  it('the BFF forwards a sample start’s idempotency key only when it is one, and refuses anything else', async () => {
    expect(engineBody('sample', 'prod-eu', {})).toEqual({ action: 'sandbox_sample_start', fleet_id: 'prod-eu' });
    expect(engineBody('sample', 'prod-eu', { idempotencyKey: 'press-1' }))
      .toEqual({ action: 'sandbox_sample_start', fleet_id: 'prod-eu', idempotency_key: 'press-1' });
    for (const bad of [42, '', 'has space', 'x'.repeat(129), 'semi;colon']) {
      const out = engineBody('sample', 'prod-eu', { idempotencyKey: bad });
      expect('error' in out && (out.error as Response).status).toBe(400);
    }
  });

  it('the page reads the refusal’s code, resetAt, the 7-day reset, the R7 hold and a stopped run', () => {
    expect(sampleRefusalOf(new SandboxFleetError('x', 429, 'limit_fleet', 10, 'sandbox_daily_limit', RESET))).toBe('sandbox_daily_limit');
    expect(sampleRefusalOf(new SandboxFleetError('x', 429, 'limit_fleet'))).toBe('limit_fleet');
    expect(sampleRefusalOf(new SandboxFleetError('x', 503, 'free_paused', 60, 'free_paused'))).toBe('free_paused');
    expect(sampleRefusalOf(new SandboxFleetError('x', 400, 'made_up'))).toBeNull();
    const st = statusOf({ exists: true, sandboxFleetId: 'sandbox-1', createdAt: RESET, key: null, autoResetAt: RESET });
    expect(st).toMatchObject({ autoResetAt: RESET });
    expect(statusOf({ exists: true, sandboxFleetId: 'sandbox-1', createdAt: RESET, key: null, autoResetAt: 'nope' })).not.toHaveProperty('autoResetAt');
    const cs = checkStateOf({
      window: { id: 'w', startedAt: RESET, endedAt: RESET, stage: 'done', endReason: 'free_paused' }, checks: [],
      activity: { lastCallAt: null, callsOutsideWindow24h: 0, dailyLimitResetAt: RESET },
    });
    expect(cs?.window?.endReason).toBe('free_paused');
    expect(cs?.activity?.dailyLimitResetAt).toBe(RESET);
    expect(checkStateOf({ window: { id: 'w', startedAt: RESET, stage: 'done', endReason: 'other' }, checks: [] })?.window).not.toHaveProperty('endReason');
  });

  it('practice: a daily-limit start in §3.10’s words, a run stopped by the switch, and the CLI’s engine text never shown', () => {
    expect(plain(refusalText(new PracticeError('You can start more tomorrow (00:00 UTC).', 429, 'starts_today'))))
      .toMatch(/^You've used today's practice runs\. You can start more (tomorrow )?at \d{1,2}:\d{2} [AP]M your time\.$/);
    expect(refusalText(new PracticeError('x', 503, 'free_paused', { code: 'free_paused' }))).toBe(R.FREE_PAUSED_LINE);
    // The proxy's shape: the code and reset under `whiteroom`.
    expect(plain(refusalText(new PracticeError('… 00:00 UTC.', 402, undefined, { whiteroom: { reason: 'sandbox_daily_limit', resetAt: RESET } }), undefined, NOW)))
      .toMatch(/^You've used today's practice runs\. You can start more (tomorrow )?at \d{1,2}:\d{2} [AP]M your time\.$/);
    expect(endedBecause('free_paused')).toBe(R.FREE_PAUSED_STOPPED);
  });

  it('a call WhiteRoom refused for the daily limit is never listed as a provider failure', () => {
    expect(failedCallsOf({ failedCalls: { count: 3, last: { at: '2026-10-29T15:00:00Z', agentId: 'a', status: 402, reason: 'sandbox_daily_limit', message: '' } } } as never)).toBeNull();
    expect(failedCallsOf({ failedCalls: { count: 1, last: { at: '2026-10-29T15:00:00Z', agentId: 'a', status: 401, reason: 'upstream_error', message: 'bad key' } } } as never)?.count).toBe(1);
  });
});

describe('§10.6: busy reads retry quietly', () => {
  const busyOf = (e: unknown) => (e === 'busy' ? { retryAfter: 2 } : null);
  it('Retry-After is the floor, with full-jitter backoff; anything else is thrown at once', async () => {
    const sleeps: number[] = [];
    let n = 0;
    const read = async () => { if (n++ < 2) throw 'busy'; return 'ok'; };
    await expect(R.retryBusyRead(read, busyOf, { random: () => 1, sleep: async (ms) => { sleeps.push(ms); } })).resolves.toBe('ok');
    expect(sleeps).toEqual([2000, 2000]);
    const sleeps2: number[] = [];
    let m = 0;
    await expect(R.retryBusyRead(async () => { if (m++ < 6) throw 'busy'; return 'ok'; }, () => ({}), { random: () => 1, sleep: async (ms) => { sleeps2.push(ms); } })).resolves.toBe('ok');
    expect(sleeps2).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
    await expect(R.retryBusyRead(async () => { throw 'other'; }, busyOf)).rejects.toBe('other');
  });
  it('gives up after two minutes, and when the page goes', async () => {
    let clock = 0;
    await expect(R.retryBusyRead(async () => { throw 'busy'; }, () => ({ retryAfter: 50 }), { now: () => clock, sleep: async (ms) => { clock += ms; } })).rejects.toBe('busy');
    expect(clock).toBe(100_000);
    const gone = new AbortController();
    let tries = 0;
    await expect(R.retryBusyRead(async () => { tries++; throw 'busy'; }, busyOf, { signal: gone.signal, sleep: async () => { gone.abort(); } })).rejects.toBe('busy');
    expect(tries).toBe(1);
  });
});

describe('§5: one line above the steps', () => {
  const FREE = { plan: 'free' as const, canBuy: false, invite: null };
  it('7-day reset → invite → Free line; only Free (bar the reset), and the Free/invite lines only on Connect', () => {
    expect(sandboxPlanLine(FREE, { resetUnseen: true, connect: true })?.kind).toBe('reset');
    expect(sandboxPlanLine({ ...FREE, invite: 'Acme' }, { resetUnseen: false, connect: true })).toEqual({ kind: 'invite', text: 'Acme invited you to join their organization.' });
    expect(plain(sandboxPlanLine(FREE, { resetUnseen: false, connect: true })?.text)).toBe("You're on Free. Your 30 free days start when you take an agent live.");
    expect(sandboxPlanLine(FREE, { resetUnseen: false, connect: false })).toBeNull();
    expect(sandboxPlanLine(OTHER_PLAN, { resetUnseen: false, connect: true })).toBeNull();
    expect(sandboxPlanLine({ plan: 'suspended', canBuy: true, invite: null }, { resetUnseen: false, connect: true })).toBeNull();
    // Never on an organization's fleet or another plan, the reset line included.
    expect(sandboxPlanLine(OTHER_PLAN, { resetUnseen: true, connect: false })).toBeNull();
    expect(sandboxPlanLine(FREE, { resetUnseen: true, connect: false })?.text).toBe('Your Sandbox history was cleared after 7 days.');
  });
});

describe('§8.6: plan lines', () => {
  it('Free’s price line and blurb, and Starter/Pro counted from going live', () => {
    expect(PLANS.free.priceLine).toBe('Free. Sandbox only.');
    expect(PLANS.free.blurb).toBe('Sandbox only. Take an agent live to start your 30 free days.');
    expect(PLANS.starter.priceLine).toBe('20% of what WhiteRoom saves you. 30 days free once you go live; $10 a month per user from your 61st day live.');
    expect(PLANS.pro.priceLine).toBe('10% of what WhiteRoom saves you. 30 days free once you go live; $300 a month per organization from your 61st day live.');
  });
});

// ── The page ──

const flush = async () => { for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); }); };
let root: Root;
const text = () => document.body.textContent ?? '';
// A new key each time: a preview's state is read once, on mount.
let mounts = 0;
const render = async (props: Parameters<typeof SandboxHome>[0]) => { await act(async () => { root.render(h(SandboxHome, { ...props, key: ++mounts })); }); await flush(); };
const button = (name: string) => [...document.querySelectorAll('button')].filter((b) => b.textContent?.trim() === name).pop() as HTMLButtonElement | undefined;
const link = (name: string) => [...document.querySelectorAll('a')].find((a) => a.textContent?.trim() === name);
const bff = vi.fn();
beforeEach(() => {
  document.body.appendChild(document.createElement('div'));
  root = createRoot(document.body.firstChild as HTMLDivElement);
  getSandboxPlan.mockReset().mockResolvedValue(OTHER_PLAN);
  takeItLive.mockReset();
  capture.mockReset();
  bff.mockReset().mockImplementation(async () => Response.json({ success: true, exists: false, sampleAvailable: true }));
  vi.stubGlobal('fetch', bff);
  try { localStorage.clear(); } catch { /* none */ }
});
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals(); });

describe('Sandbox page on Free (mockups S2, S4, S8–S10, S18, S19)', () => {
  it('S2: the Free line above the steps, in the plan-banner wrapper; S10: an invite replaces it, with See invite', async () => {
    await render({ fleet: 'prod-eu', preview: SANDBOX_V2_STATES['free-connect'] });
    const wrap = document.querySelector('.wr-plan-banner');
    expect(plain(wrap?.textContent)).toBe("You're on Free. Your 30 free days start when you take an agent live.");
    // Above the steps.
    expect(wrap!.compareDocumentPosition(document.querySelector('[aria-label="Sandbox steps"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await render({ fleet: 'prod-eu', preview: SANDBOX_V2_STATES['free-invite'] });
    expect(document.querySelector('.wr-plan-banner')?.textContent).toContain('Acme Robotics invited you to join their organization.');
    expect(text()).not.toContain('You’re on Free');
    expect(link('See invite')?.getAttribute('href')).toBe('/organization');
    expect(link('See invite')?.className).toContain('wr-btn--primary');
  });

  it('S18: the 7-day reset line shows once per reset on this browser, in place of the Free line', async () => {
    const at = '2026-10-28T00:00:00.000Z';
    getSandboxPlan.mockResolvedValue({ plan: 'free', canBuy: false, invite: null });
    bff.mockImplementation(async () => Response.json({ success: true, exists: false, sampleAvailable: true, autoResetAt: at }));
    // exists:false carries no autoResetAt: no line.
    await render({ fleet: 'prod-eu' });
    expect(text()).not.toContain('history was cleared');
    act(() => root.unmount()); root = createRoot(document.body.appendChild(document.createElement('div')));
    bff.mockImplementation(async (url: string) => url.includes('/checks/')
      ? Response.json({ success: true, window: null, checks: [], rules: [] })
      : Response.json({ success: true, exists: true, sandboxFleetId: 'sandbox-1', createdAt: at, lastCallAt: null, expiresAt: null, key: { prefix: 'sk-wr-0123456789abcdef...', provider: 'anthropic', keyHint: 'WXYZ' }, autoResetAt: at }));
    await render({ fleet: 'prod-eu' });
    expect(document.querySelector('.wr-plan-banner')?.textContent).toBe('Your Sandbox history was cleared after 7 days.');
    act(() => root.unmount()); root = createRoot(document.body.appendChild(document.createElement('div')));
    await render({ fleet: 'prod-eu' });
    expect(text()).not.toContain('history was cleared');
  });

  it('a non-Free account sees no plan line and today’s verdict (FREE_PLAN plays no part)', async () => {
    await render({ fleet: 'prod-eu' });
    expect(getSandboxPlan).toHaveBeenCalledWith('prod-eu');
    expect(document.querySelector('.wr-plan-banner')).toBeNull();
    await render({ fleet: 'prod-eu', preview: { ...SANDBOX_V2_STATES['free-take-it-live'], plan: undefined } });
    expect(text()).toContain('Ready for live traffic. Point your agent at WhiteRoom from Fleet key.');
    expect(button('Take it live')).toBeUndefined();
    expect(text()).not.toContain('Choose a plan');
  });

  it('S4: Ready for live traffic, Take it live (primary), and the sub-line; busy, refused and network states', async () => {
    await render({ fleet: 'prod-eu', preview: SANDBOX_V2_STATES['free-take-it-live'] });
    expect(text()).toContain('Ready for live traffic.Take it liveStarts your 30 free days. No card needed.');
    expect(button('Take it live')?.className).toContain('wr-btn--primary');
    expect(text()).not.toContain('Point your agent at WhiteRoom');
    await render({ fleet: 'prod-eu', preview: SANDBOX_V2_STATES['free-take-it-live-busy'] });
    expect(button('Taking it live…')?.disabled).toBe(true);
    await render({ fleet: 'prod-eu', preview: SANDBOX_V2_STATES['free-take-it-live-refused'] });
    const alert = document.querySelector('[role="alert"]');
    expect(plain(alert?.textContent)).toBe("Couldn't take it live. Try again.");
    // Above the sub-line, which stays; the button stays.
    expect(alert?.nextElementSibling?.textContent).toBe('Starts your 30 free days. No card needed.');
    expect(button('Take it live')).toBeDefined();
    await render({ fleet: 'prod-eu', preview: SANDBOX_V2_STATES['free-take-it-live-network'] });
    expect(plain(document.querySelector('[role="alert"]')?.textContent)).toBe("That didn't work. Check your connection and try again.");
  });

  it('Take it live: one call, never retried; a refusal or no answer says so; success tells the plan banners, counts the event and fully loads Fleet key', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    const changed = vi.fn();
    window.addEventListener(PLAN_CHANGED, changed);
    // A preview's verdict never calls: the button on its own, live.
    const { TakeItLive } = await import('@/components/sandbox/v2/SandboxChecks');
    takeItLive.mockResolvedValueOnce({ ok: false });
    await act(async () => { root.render(h(TakeItLive, {})); }); await flush();
    await act(async () => { button('Take it live')!.click(); }); await flush();
    expect(takeItLive).toHaveBeenCalledTimes(1);
    expect(takeItLive).toHaveBeenCalledWith('verdict');
    expect(plain(document.querySelector('[role="alert"]')?.textContent)).toBe("Couldn't take it live. Try again.");
    takeItLive.mockRejectedValueOnce(new Error('offline'));
    await act(async () => { button('Take it live')!.click(); }); await flush();
    expect(plain(document.querySelector('[role="alert"]')?.textContent)).toBe("That didn't work. Check your connection and try again.");
    expect(takeItLive).toHaveBeenCalledTimes(2);
    takeItLive.mockResolvedValueOnce({ ok: true, trialEndsAt: '2026-12-08T00:00:00Z' });
    await act(async () => { button('Take it live')!.click(); }); await flush();
    expect(changed).toHaveBeenCalledTimes(1);
    window.removeEventListener(PLAN_CHANGED, changed);
    expect(capture).toHaveBeenCalledWith('take_it_live', { where: 'verdict' });
    expect(assign).toHaveBeenCalledWith('/fleet-key?live=1#point');
    expect(button('Taking it live…')?.disabled).toBe(true);
  });

  it('S19: Suspended: Choose a plan → /settings#plan, or Talk to us while nothing can be bought; never both', async () => {
    await render({ fleet: 'prod-eu', preview: SANDBOX_V2_STATES['suspended-verdict'] });
    expect(text()).toContain('Ready for live traffic. Choose a plan to switch your fleets back on.');
    expect(link('Choose a plan')?.getAttribute('href')).toBe('/settings#plan');
    expect(link('Talk to us')).toBeUndefined();
    expect(button('Take it live')).toBeUndefined();
    await render({ fleet: 'prod-eu', preview: SANDBOX_V2_STATES['suspended-verdict-talk'] });
    expect(text()).toContain('Ready for live traffic. Talk to us to switch your fleets back on.');
    expect(link('Talk to us')?.getAttribute('href')).toMatch(/^mailto:/);
    expect(link('Choose a plan')).toBeUndefined();
  });

  it('S8: the R7 line replaces the live line in the checks card; S9: paused is a warn line with no action, and a stopped run says so', async () => {
    await render({ fleet: 'prod-eu', preview: SANDBOX_V2_STATES['free-calls-limit'] });
    expect(text()).toMatch(/Your Sandbox hit today’s limit of 1,000 calls\. It takes calls again (tomorrow )?at \d{1,2}:\d{2} [AP]M your time\./);
    expect(text()).not.toContain('is calling');
    await render({ fleet: 'prod-eu', preview: SANDBOX_V2_STATES['free-paused'] });
    const warn = document.querySelector('.wr-banner--warn');
    expect(warn?.textContent).toContain(R.FREE_PAUSED_LINE);
    expect(warn?.querySelector('button')).toBeNull();
    expect(document.querySelector('.wr-banner--error')).toBeNull();
    expect(text()).toContain(R.FREE_PAUSED_STOPPED);
  });

  it('a sample start refused by the switch goes to the error slot (warn, no Try again), and is counted by code', async () => {
    bff.mockImplementation(async (url: string) => url.endsWith('/fleet/sample')
      ? Response.json({ error: R.FREE_PAUSED_LINE, reason: 'free_paused', code: 'free_paused' }, { status: 503 })
      : Response.json({ success: true, exists: false, sampleAvailable: true }));
    await render({ fleet: 'prod-eu' });
    await act(async () => { button('Try a sample agent')!.click(); }); await flush();
    expect(document.querySelector('.wr-banner--warn')?.textContent).toContain(R.FREE_PAUSED_LINE);
    expect(button('Try again')).toBeUndefined();
    expect(capture).toHaveBeenCalledWith('sandbox_v2_sample_refused', { reason: 'free_paused' });
  });

  it('Connect refused by the switch: the page’s warn line, not a red line in the form', async () => {
    bff.mockImplementation(async (url: string) => url.endsWith('/fleet/connect')
      ? Response.json({ error: R.FREE_PAUSED_LINE, reason: 'free_paused', code: 'free_paused' }, { status: 503 })
      : Response.json({ success: true, exists: false, sampleAvailable: true }));
    await render({ fleet: 'prod-eu' });
    const input = document.querySelector('input[type="password"], input[name="api_key"], input') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'sk-ant-placeholder-not-a-real-key-WXYZ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { button('Connect')!.click(); }); await flush();
    expect(document.querySelector('.wr-banner--warn')?.textContent).toContain(R.FREE_PAUSED_LINE);
    expect(document.querySelectorAll('.wr-banner--error, [role="alert"]').length).toBe(0);
  });

  it('the 402 daily limit: the button gives way to the line in the viewer’s zone; the global budget its own line', async () => {
    bff.mockImplementation(async (url: string) => url.endsWith('/fleet/sample')
      ? Response.json({ error: 'x', reason: 'sandbox_daily_limit', code: 'sandbox_daily_limit', resetAt: new Date(Date.now() + 3_600_000).toISOString() }, { status: 402 })
      : Response.json({ success: true, exists: false, sampleAvailable: true }));
    await render({ fleet: 'prod-eu' });
    await act(async () => { button('Try a sample agent')!.click(); }); await flush();
    expect(text()).toMatch(/You’ve used today’s sample runs\. More (tomorrow )?at \d{1,2}:\d{2} [AP]M your time, or use your own key now\./);
    expect(button('Try a sample agent')).toBeUndefined();
    await render({ fleet: 'prod-eu', preview: SANDBOX_V2_STATES['sample-budget'] });
    expect(text()).toContain(R.SAMPLE_BUDGET_LINE);
  });

  it('a busy checks poll stays quiet while the next polls retry it, and says so once it has lasted two minutes', async () => {
    const { SandboxChecks } = await import('@/components/sandbox/v2/SandboxChecks');
    let reads = 0;
    bff.mockImplementation(async () => (reads++ === 0
      ? Response.json({ success: true, window: null, checks: [], rules: [] })
      : Response.json({ error: R.SANDBOX_BUSY_LINE, reason: 'sandbox_busy', code: 'sandbox_busy' }, { status: 503 })));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      await act(async () => { root.render(h(SandboxChecks, { fleet: 'prod-eu', sandboxFleetId: 'sandbox-1' })); });
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
      expect(reads).toBeGreaterThan(2);
      expect(text()).not.toContain(R.SANDBOX_BUSY_LINE);
      await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
      expect(text()).toContain(R.SANDBOX_BUSY_LINE);
    } finally { vi.useRealTimers(); }
  });

  it('a busy status read is retried quietly, not shown', async () => {
    let n = 0;
    bff.mockImplementation(async () => (n++ === 0
      ? Response.json({ error: R.SANDBOX_BUSY_LINE, reason: 'sandbox_busy', code: 'sandbox_busy' }, { status: 503 })
      : Response.json({ success: true, exists: false, sampleAvailable: true })));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await act(async () => { root.render(h(SandboxHome, { fleet: 'prod-eu' })); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
      await flush();
    } finally { vi.useRealTimers(); }
    expect(n).toBe(2);
    expect(text()).not.toContain('busy');
    expect(text()).toContain('Try a sample agent');
  });
});
