// The Sandbox's refusal codes in the dashboard's words (Free tier spec
// Part 1 §3.10: one text per message), the reset time in the viewer's time
// zone (§2), and the quiet retry of reads while the Sandbox is busy (Part 2
// §10.6). Pure, so the words are pinned by tests.

import { dayKey, viewerZone } from '@/lib/zone-time';

/** Free Sandbox calls a day (R7): the number the calls line names. */
export const SANDBOX_DAILY_CALLS = 1000;

export const NETWORK_LINE = 'That didn’t work. Check your connection and try again.';
export const FREE_PAUSED_LINE = 'Sandbox isn’t taking new runs right now. Nothing you set up is lost. Try again later.';
export const FREE_PAUSED_STOPPED = 'Stopped: Sandbox isn’t taking runs right now. Run it again later.';
export const SANDBOX_BUSY_LINE = 'Sandbox is busy. Try again in a moment.';
export const DB_UNAVAILABLE_LINE = 'Sandbox can’t take calls right now. Try again in a moment.';
export const SAMPLE_BUDGET_LINE = 'Our sample agent is done for today. You can still use your own key.';

/** Busy answers: a read is retried quietly, a refused button press says SANDBOX_BUSY_LINE. */
export const BUSY_CODES: readonly string[] = ['sandbox_busy', 'control_busy', 'cleanup_busy'];
/** Every code the dashboard words itself, whatever text came with it. */
export const SANDBOX_CODES: readonly string[] = [...BUSY_CODES, 'db_unavailable', 'free_paused', 'sandbox_daily_limit', 'sample_budget_exhausted'];

/** The next 00:00 UTC after `now`: when every daily limit resets. */
export function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** `resetAt` as a time still ahead of `now`; else (missing, unreadable or past) the next 00:00 UTC. */
export function resetMs(resetAt: string | null | undefined, now: number): number {
  const t = resetAt ? Date.parse(resetAt) : NaN;
  return Number.isFinite(t) && t > now ? t : nextUtcMidnight(now);
}

/**
 * When a daily limit resets, in the viewer's zone (§2): "at 7:00 PM your
 * time", or "tomorrow at 5:30 AM your time" when it falls on the viewer's
 * next calendar day. Never "00:00 UTC": only the engine and CLI say that.
 */
export function resetWords(resetAt: string | null | undefined, now: number, tz: string = viewerZone()): string {
  const at = resetMs(resetAt, now);
  const clock = clockFormat(tz).format(new Date(at)).replace(/\s/g, ' ');
  return `${dayKey(at, tz) === dayKey(now, tz) ? '' : 'tomorrow '}at ${clock} your time`;
}

const clocks = new Map<string, Intl.DateTimeFormat>();
/** "7:00 PM" in `tz`, one formatter per zone (it's built on every checks render otherwise). */
function clockFormat(tz: string): Intl.DateTimeFormat {
  let f = clocks.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz || undefined }); clocks.set(tz, f); }
  return f;
}

/** Sample runs a day used up (the Connect step, under the sample offer). */
export const sampleLimitLine = (resetAt: string | null | undefined, now: number, tz?: string) =>
  `You’ve used today’s sample runs. More ${resetWords(resetAt, now, tz)}, or use your own key now.`;
/** Practice runs a day used up (practice start). */
export const practiceLimitLine = (resetAt: string | null | undefined, now: number, tz?: string) =>
  `You’ve used today’s practice runs. You can start more ${resetWords(resetAt, now, tz)}.`;
/** Free Sandbox calls a day used up (R7: the checks card, in place of the live line). */
export const callsLimitLine = (resetAt: string | null | undefined, now: number, tz?: string) =>
  `Your Sandbox hit today’s limit of ${SANDBOX_DAILY_CALLS.toLocaleString('en-US')} calls. It takes calls again ${resetWords(resetAt, now, tz)}.`;

/** A refusal as the BFF passes it on: status, reason, code and resetAt. */
export interface Refused {
  status: number;
  reason?: string;
  code?: string;
  resetAt?: string;
}

/** The one code a refusal means: the spec's code when sent, else today's reason (429 limit_fleet / limit_global / starts_today). */
export function refusalCode(r: Refused): string | undefined {
  if (r.code && SANDBOX_CODES.includes(r.code)) return r.code;
  switch (r.reason) {
    case 'limit_fleet': case 'starts_today': return 'sandbox_daily_limit';
    case 'limit_global': return 'sample_budget_exhausted';
    default: return r.reason && SANDBOX_CODES.includes(r.reason) ? r.reason : undefined;
  }
}

/**
 * The §3.10 words for a refused Sandbox action, or null when the code isn't
 * one of the Sandbox's own (the caller keeps today's message). `what`: whose
 * daily limit a sandbox_daily_limit is.
 */
export function refusalWords(r: Refused, what: 'sample' | 'practice' | 'calls' | 'other', now: number, tz?: string): string | null {
  const code = refusalCode(r);
  switch (code) {
    case 'free_paused': return FREE_PAUSED_LINE;
    case 'db_unavailable': return DB_UNAVAILABLE_LINE;
    case 'sample_budget_exhausted': return SAMPLE_BUDGET_LINE;
    case 'sandbox_daily_limit':
      if (what === 'sample') return sampleLimitLine(r.resetAt, now, tz);
      if (what === 'practice') return practiceLimitLine(r.resetAt, now, tz);
      if (what === 'calls') return callsLimitLine(r.resetAt, now, tz);
      return null;
    default: return code && BUSY_CODES.includes(code) ? SANDBOX_BUSY_LINE : null;
  }
}

/** A busy answer (503 sandbox_busy, control_busy, cleanup_busy): reads retry it quietly. */
export const isBusy = (r: Refused) => {
  const code = refusalCode(r);
  return r.status === 503 && !!code && BUSY_CODES.includes(code);
};

/** Retry rules for reads (Part 2 §10.6). */
export const READ_RETRY = { baseMs: 1000, maxMs: 30_000, lifetimeMs: 120_000 } as const;

/**
 * Runs a read, retrying it while the Sandbox answers busy: Retry-After is the
 * floor, exponential backoff with full jitter, given up after 2 minutes, and
 * stopped when `signal` aborts (the page went). Only for reads: a mutation is
 * never retried here. Any other error, or the last busy one, is thrown.
 */
export async function retryBusyRead<T>(
  read: () => Promise<T>,
  busyOf: (e: unknown) => { retryAfter?: number } | null,
  opts: { signal?: AbortSignal; random?: () => number; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; now?: () => number } = {},
): Promise<T> {
  const { signal, random = Math.random, sleep = wait, now = Date.now } = opts;
  const started = now();
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (e) {
      const busy = busyOf(e);
      if (!busy || signal?.aborted) throw e;
      const backoff = random() * Math.min(READ_RETRY.maxMs, READ_RETRY.baseMs * 2 ** attempt);
      const delay = Math.max((busy.retryAfter ?? 0) * 1000, backoff);
      if (now() - started + delay > READ_RETRY.lifetimeMs) throw e;
      await sleep(delay, signal);
      if (signal?.aborted) throw e;
    }
  }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); }
    signal?.addEventListener('abort', done, { once: true });
  });
}
