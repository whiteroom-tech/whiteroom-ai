// WhiteRoom's Free tier answers, in plain words: a busy WhiteRoom or Sandbox
// (503, retry after a moment), Free Sandbox work paused (503), the day's
// Sandbox calls or runs used up, and production refusals (402). Shared by the
// practice, sandbox and fleet commands. No codes are printed, only what to do.
//
// WhiteRoom's reply already says it in words: those are printed as sent. The
// texts below are the same words, for a reply that carries none.

const US_DASHBOARD = "https://app.whiteroom.tech";
const EU_DASHBOARD = "https://eu.app.whiteroom.tech";

/** The dashboard for the WhiteRoom address the CLI was pointed at: EU for eu.proxy.whiteroom.tech, else the US one. */
export function dashboardFor(engineUrl?: string | null): string {
  let host = "";
  try {
    host = new URL(engineUrl ?? "").hostname.toLowerCase();
  } catch {
    // Not a URL: the US dashboard.
  }
  return host.startsWith("eu.proxy.") && host.endsWith(".whiteroom.tech") ? EU_DASHBOARD : US_DASHBOARD;
}

/** 503 answers that mean "try again in a moment": WhiteRoom refused before doing anything, so the same request can be sent again. */
export const BUSY = new Set(["sandbox_busy", "control_busy", "cleanup_busy", "db_unavailable"]);
/** A busy wait this long or longer is announced again. */
export const LONG_WAIT_S = 10;

/** One text per answer. `app` is the region's dashboard, `at` the reset time (HH:MM, UTC), `wait` how long to wait. */
export const responseCopy = {
  freePaused: "Sandbox isn't taking new runs right now. Nothing you set up is lost. Try again later.",
  sandboxBusy: (wait: string) => `Sandbox is busy. Try again in ${wait}.`,
  controlBusy: (wait: string) => `WhiteRoom is busy. Try again in ${wait}.`,
  dbUnavailable: (wait: string) => `Sandbox can't take calls right now. Try again in ${wait}.`,
  /** Without WhiteRoom's words the cap isn't known, so no number. */
  callsToday: (at: string) => `Your Sandbox hit today's call limit. It takes calls again at ${at} UTC.`,
  sampleRunsToday: (at: string) => `You've used today's sample runs. More at ${at} UTC, or use your own key now.`,
  practiceRunsToday: (at: string) => `You've used today's practice runs. You can start more at ${at} UTC.`,
  sampleBudgetExhausted: "Our sample agent is done for today. You can still use your own key.",
  planFree: (app: string) => `Free accounts can't make live calls. Click Go live at ${app} to start your 30 free days.`,
  suspended: (app: string) => `Your plan has ended, so your agents' live calls are refused. Choose a plan to switch them back on. Nothing is lost.\n${app}/settings#plan`,
  unclaimed: (app: string) => `This line isn't set up yet. Sign in at ${app} and copy your line from the Fleet key page.`,
  revoked: (app: string) => `This key no longer works. Get your current line from the Fleet key page at ${app}.`,
};

/** The reason codes a reply carries: in `whiteroom.reason`, `reason` or `code` (the sample start puts the daily limit in `code`). */
function codesOf(body: any): string[] {
  if (!body || typeof body !== "object") return [];
  return [body.whiteroom?.reason, body.reason, body.code].filter((x): x is string => typeof x === "string");
}

const GATE = ["plan_free", "suspended", "unclaimed", "revoked", "not_available"];

/**
 * The Free tier code a reply carries, if any: a busy or paused 503, a 402
 * refusal, or a day's limit (402 calls; 429 sample or practice runs). Older
 * WhiteRoom answers name the sample limits only by reason (limit_fleet,
 * limit_global): they map to the same codes.
 */
export function freeTierCode(status: number, body: any): string | null {
  const codes = codesOf(body);
  if (codes.includes("free_paused")) return "free_paused";
  if (codes.includes("sandbox_daily_limit")) return "sandbox_daily_limit";
  if (codes.includes("sample_budget_exhausted")) return "sample_budget_exhausted";
  if (status === 503) return codes.find((c) => BUSY.has(c)) ?? null;
  if (status === 402) return codes.find((c) => GATE.includes(c)) ?? null;
  if (status === 429) {
    if (codes.includes("limit_fleet")) return "sandbox_daily_limit";
    if (codes.includes("limit_global")) return "sample_budget_exhausted";
    if (codes.includes("starts_today")) return "starts_today";
  }
  return null;
}

/**
 * The one Retry-After parser: seconds to wait, at least 1 and at most `max`
 * (60 for a wait the CLI does itself), or null when the header is missing or
 * isn't a number of seconds.
 */
export function retryAfterSeconds(header: string | null | undefined, max = 60): number | null {
  const n = Number(header);
  return header == null || header.trim() === "" || !Number.isFinite(n) ? null : Math.min(Math.max(Math.ceil(n), 1), max);
}

/** "a moment", "30 seconds", "a minute", "2 minutes": how long Retry-After asks for, in words ("a moment" for a short or missing one). */
export function waitWords(header: string | null | undefined): string {
  const n = retryAfterSeconds(header, Infinity);
  if (n === null || n < LONG_WAIT_S) return "a moment";
  if (n < 60) return `${n} seconds`;
  const m = Math.round(n / 60);
  return m <= 1 ? "a minute" : `${m} minutes`;
}

/** Refusals running the same command again won't fix (the day's limits, the plan): a setup problem (exit 2), not a retry (3). */
export function rerunWontFix(status: number, body: any): boolean {
  const code = freeTierCode(status, body);
  return code !== null && code !== "free_paused" && !BUSY.has(code);
}

/** When the day's limit resets, as HH:MM (UTC) from the reply's resetAt; midnight when it has none. */
function resetTime(body: any): string {
  const at = Date.parse(body?.whiteroom?.resetAt ?? body?.resetAt ?? "");
  if (!Number.isFinite(at)) return "00:00";
  return new Date(at).toISOString().slice(11, 16);
}

const MAX_WORDS = 600;
/** Control, zero-width, line/paragraph separator and bidi characters, never printed (a plain line break is kept). */
const UNPRINTABLE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g;

/** The words WhiteRoom's reply carries (`error`, or `error.message`), safe to print; null when there are none. */
export function replyWords(body: any): string | null {
  const raw = typeof body?.error === "string" ? body.error : typeof body?.error?.message === "string" ? body.error.message : null;
  if (raw === null) return null;
  const words = raw.replace(/\r\n?/g, "\n").replace(UNPRINTABLE, "").trim();
  return words && words.length <= MAX_WORDS ? words : null;
}

/** This CLI's own text for a Free tier code, for a reply without words. */
function ownText(code: string, r: { status: number; body: any; retryAfter?: string | null }, app: string): string | null {
  const wait = waitWords(r.retryAfter);
  switch (code) {
    case "free_paused": return responseCopy.freePaused;
    case "sandbox_busy":
    case "cleanup_busy": return responseCopy.sandboxBusy(wait);
    case "control_busy": return responseCopy.controlBusy(wait);
    case "db_unavailable": return responseCopy.dbUnavailable(wait);
    case "sandbox_daily_limit": return r.status === 429 ? responseCopy.sampleRunsToday(resetTime(r.body)) : responseCopy.callsToday(resetTime(r.body));
    case "starts_today": return responseCopy.practiceRunsToday(resetTime(r.body));
    case "sample_budget_exhausted": return responseCopy.sampleBudgetExhausted;
    case "plan_free": return responseCopy.planFree(app);
    case "suspended": return responseCopy.suspended(app);
    case "unclaimed":
    case "not_available": return responseCopy.unclaimed(app);
    case "revoked": return responseCopy.revoked(app);
    default: return null;
  }
}

/**
 * The plain message for a Free tier answer, or null when the reply isn't one:
 * WhiteRoom's own words when the reply carries them, else this CLI's text.
 * The production refusals (402) always use this CLI's text: it links to the
 * dashboard of the region `engineUrl` is in, which an older reply may not.
 */
export function freeTierMessage(r: { status: number; body: any; retryAfter?: string | null }, engineUrl?: string | null): string | null {
  const code = freeTierCode(r.status, r.body);
  if (code === null) return null;
  const own = () => ownText(code, r, dashboardFor(engineUrl));
  return GATE.includes(code) ? own() : replyWords(r.body) ?? own();
}
