import { ControlDeniedError, exportCallsPage, WhiteRoomApiError } from '@/lib/whiteroom/client';
import type { CallExportPage, CallExportScope } from '@/lib/whiteroom/types';
import { DASHBOARD_ONLY_REASON } from '@/lib/audit-export';

/** How a page fetch is made; the client's by default, swapped in tests. */
export type FetchCallPage = (fleetId: string, ask: CallExportScope | { state: Record<string, unknown> }) => Promise<CallExportPage>;

/**
 * The signed log couldn't be made, for a reason worth telling the person as
 * is: too many calls for one file, not the fleet's owner, or an engine that
 * doesn't have it yet.
 */
export class CallExportRefused extends Error {
  constructor(readonly plain: string) {
    super(plain);
    this.name = 'CallExportRefused';
  }
}

export const CALL_EXPORT_UNAVAILABLE = 'Signed log isn’t available yet.';
const TOO_MANY = /^That[’']s too many calls/;

/** Why the engine or the dashboard refused, when it's one of the reasons to show as is; else null. */
function refusalOf(e: unknown): string | null {
  if (e instanceof ControlDeniedError) return e.message;
  if (!(e instanceof WhiteRoomApiError)) return null;
  // An older engine doesn't know the action (400), or wants the service
  // secret before this dashboard sends one (403).
  if ((e.status === 400 && e.reason === 'Unknown action.') || (e.status === 403 && e.reason === DASHBOARD_ONLY_REASON)) return CALL_EXPORT_UNAVAILABLE;
  if (e.status === 400 && e.reason && TOO_MANY.test(e.reason)) return e.reason;
  return null;
}

/** Busy, rate-limited or briefly unreachable: worth a short wait and another try. */
const RETRYABLE = new Set([429, 502, 503]);
const RETRIES = 3;
const RETRY_WAIT_MS = 5_000;
const WAIT_STEP_MS = 250;
/** More pages than any file has (50,000 calls at 1 a page would still be refused long before): a guard against a loop. */
const MAX_PAGES = 1_000;

/**
 * A fleet's call records for one run or a range of days, as one file signed
 * by WhiteRoom, fetched a page at a time. Each page becomes its own Blob as
 * it arrives. The file is
 *   { format, version, fleetId, calls: [...], manifest: { …, signature } }
 * with one call per line. It holds what Runs shows about a call: no prompts,
 * replies or tool arguments.
 */
export async function buildCallExport(
  fleetId: string,
  scope: CallExportScope,
  onProgress: (done: number) => void,
  opts: { fetchPage?: FetchCallPage; isCancelled?: () => boolean; wait?: (ms: number) => Promise<void> } = {},
): Promise<{ blob: Blob; calls: number } | null> {
  const fetchPage = opts.fetchPage ?? ((id, ask) => exportCallsPage(id, ask));
  const wait = opts.wait ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const cancelled = () => opts.isCancelled?.() === true;
  /** A page, retried while the engine is busy; null once the export is cancelled. */
  const get = async (ask: CallExportScope | { state: Record<string, unknown> }): Promise<CallExportPage | null> => {
    for (let attempt = 0; ; attempt++) {
      if (cancelled()) return null;
      try {
        return await fetchPage(fleetId, ask);
      } catch (e) {
        // A refusal on any page (the first, or one part-way through) is told as it is.
        const plain = refusalOf(e);
        if (plain) throw new CallExportRefused(plain);
        if (attempt >= RETRIES || !(e instanceof WhiteRoomApiError) || !RETRYABLE.has(e.status ?? 0)) throw e;
        // Waited in short steps, so a cancel stops it straight away.
        for (let left = RETRY_WAIT_MS * (attempt + 1); left > 0; left -= WAIT_STEP_MS) {
          if (cancelled()) return null;
          await wait(Math.min(WAIT_STEP_MS, left));
        }
      }
    }
  };

  let page = await get(scope);
  if (!page) return null;

  const parts: BlobPart[] = [`{"format":"whiteroom-call-export","version":1,"fleetId":${JSON.stringify(fleetId)},"calls":[\n`];
  let done = 0;
  for (let pages = 1; ; pages++) {
    if (page.calls.length > 0) {
      parts.push(new Blob([(done > 0 ? ',\n' : '') + page.calls.map((c) => JSON.stringify(c)).join(',\n')]));
      done += page.calls.length;
    }
    // The engine's running count must be what was collected, page by page.
    if (page.count !== done) throw new Error('The signed log is missing calls.');
    onProgress(done);
    if (!page.state) break;
    if (cancelled()) return null;
    // Each page must bring calls, or this would never end.
    if (page.calls.length === 0 || pages >= MAX_PAGES) throw new Error('The signed log stopped moving forward.');
    page = await get({ state: page.state });
    if (!page) return null;
  }
  const m = page.manifest;
  // What was collected must be exactly what WhiteRoom signed for.
  if (!m || typeof m.signature !== 'string' || m.count !== done) throw new Error('The signed log doesn’t match its signature.');
  parts.push(`\n],"manifest":${JSON.stringify(m, null, 2)}}\n`);
  return { blob: new Blob(parts, { type: 'application/json' }), calls: done };
}
