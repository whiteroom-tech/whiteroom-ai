// WhiteRoom's Free tier answers, in plain words: a busy WhiteRoom or Sandbox
// (503, retry after a moment), Free Sandbox work paused (503), the Sandbox's
// daily calls used up and production refusals (402). Shared by the practice,
// sandbox and fleet commands. No codes are printed, only what to do.

const DASHBOARD = "https://app.whiteroom.tech";

/** 503 answers that mean "try again in a moment": WhiteRoom refused before doing anything, so the same request can be sent again. */
export const BUSY = new Set(["sandbox_busy", "control_busy", "cleanup_busy", "db_unavailable"]);
/** How many times in all a request that gets a busy answer is sent before the command says so and stops. */
export const MAX_BUSY_TRIES = 5;

export const responseCopy = {
  freePaused: "Sandbox is paused for Free accounts right now. Try again later.",
  sandboxBusy: (wait: string) => `The Sandbox is busy right now. Try again in ${wait}.`,
  controlBusy: (wait: string) => `WhiteRoom is busy right now. Try again in ${wait}.`,
  cleanupBusy: (wait: string) => `WhiteRoom is busy cleaning up Sandboxes. Try again in ${wait}.`,
  cantSave: (wait: string) => `WhiteRoom can't save Sandbox results right now. Try again in ${wait}.`,
  dailyLimit: (at: string) => `Your Sandbox has used all its calls for today. They reset at ${at} UTC.`,
  planFree: `The Free plan doesn't include production calls. Pick a plan in the dashboard (${DASHBOARD}) to use this fleet.`,
  suspended: `Production calls are paused because the last payment didn't go through. Update billing in the dashboard (${DASHBOARD}).`,
  unclaimed: `This fleet isn't linked to a WhiteRoom account yet. Sign up or sign in at ${DASHBOARD} to set it up.`,
  revoked: `This fleet is no longer linked to a WhiteRoom account. Link it again in the dashboard (${DASHBOARD}).`,
  notAvailable: `This fleet can't take production calls yet. Sign up or sign in at ${DASHBOARD} to set it up.`,
};

/** The reason codes a reply carries: in `whiteroom.reason`, `reason` or `code` (the sample start puts the daily limit in `code`). */
function codesOf(body: any): string[] {
  if (!body || typeof body !== "object") return [];
  return [body.whiteroom?.reason, body.reason, body.code].filter((x): x is string => typeof x === "string");
}

/** The Free tier code a reply carries, if any: a busy or paused 503, or a 402 (or the sample start's 429) refusal. */
export function freeTierCode(status: number, body: any): string | null {
  const codes = codesOf(body);
  if (codes.includes("free_paused")) return "free_paused";
  if (codes.includes("sandbox_daily_limit")) return "sandbox_daily_limit";
  if (status === 503) return codes.find((c) => BUSY.has(c)) ?? null;
  if (status === 402) return codes.find((c) => ["plan_free", "suspended", "unclaimed", "revoked", "not_available"].includes(c)) ?? null;
  return null;
}

/** Seconds to wait from a Retry-After header, kept between 1 and 60 (a missing or odd value waits 5). */
export function retryAfterSeconds(header: string | null | undefined): number {
  const n = Number(header);
  return header == null || header === "" || !Number.isFinite(n) ? 5 : Math.min(Math.max(Math.ceil(n), 1), 60);
}

/** "30 seconds", "a minute", "2 minutes": how long Retry-After asks for, in words. */
export function waitWords(header: string | null | undefined): string {
  const n = Number(header);
  if (header == null || header === "" || !Number.isFinite(n) || n <= 0) return "a minute";
  if (n < 60) return `${Math.ceil(n)} second${Math.ceil(n) === 1 ? "" : "s"}`;
  const m = Math.round(n / 60);
  return m <= 1 ? "a minute" : `${m} minutes`;
}

/** When the daily calls come back, as HH:MM (UTC) from the reply's resetAt; midnight when it has none. */
function resetTime(body: any): string {
  const at = Date.parse(body?.whiteroom?.resetAt ?? body?.resetAt ?? "");
  if (!Number.isFinite(at)) return "00:00";
  return new Date(at).toISOString().slice(11, 16);
}

/** The plain message for a Free tier answer, or null when the reply isn't one. */
export function freeTierMessage(r: { status: number; body: any; retryAfter?: string | null }): string | null {
  const code = freeTierCode(r.status, r.body);
  const wait = waitWords(r.retryAfter);
  switch (code) {
    case "free_paused": return responseCopy.freePaused;
    case "sandbox_busy": return responseCopy.sandboxBusy(wait);
    case "control_busy": return responseCopy.controlBusy(wait);
    case "cleanup_busy": return responseCopy.cleanupBusy(wait);
    case "db_unavailable": return responseCopy.cantSave(wait);
    case "sandbox_daily_limit": return responseCopy.dailyLimit(resetTime(r.body));
    case "plan_free": return responseCopy.planFree;
    case "suspended": return responseCopy.suspended;
    case "unclaimed": return responseCopy.unclaimed;
    case "revoked": return responseCopy.revoked;
    case "not_available": return responseCopy.notAvailable;
    default: return null;
  }
}
