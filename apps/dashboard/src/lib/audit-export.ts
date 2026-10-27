import { exportAuditFullPage, exportAuditSigned, WhiteRoomApiError } from '@/lib/whiteroom/client';
import type { AuditExportPage } from '@/lib/whiteroom/types';

/** The engine's refusal of a dashboard-only action without the service secret. */
export const DASHBOARD_ONLY_REASON = 'This action is only available from the WhiteRoom dashboard.';

/** How a page fetch is made; the client's by default, swapped in tests. */
export type FetchExportPage = (fleetId: string, cursor?: { fromSeq: number; toSeq: number }) => Promise<AuditExportPage>;

export interface AuditExportFile {
  blob: Blob;
  /** Events in the file; null for the older, shorter export. */
  events: number | null;
}

/**
 * The pages came back but don't add up to the history WhiteRoom signed: a
 * problem with the audit trail itself, not with the connection. `plain` says
 * what was wrong in a few words.
 */
export class AuditExportProblem extends Error {
  constructor(message: string, readonly plain: string) {
    super(message);
    this.name = 'AuditExportProblem';
  }
}

/** Busy, rate-limited or briefly unreachable: worth a short wait and another try. */
const RETRYABLE = new Set([429, 502, 503]);
const RETRIES = 3;
const RETRY_WAIT_MS = 5_000;
const WAIT_STEP_MS = 250;

/**
 * The fleet's whole audit history as one signed file, fetched a page at a
 * time. Each page becomes its own Blob as it arrives, so nothing here holds
 * the whole history as objects. The file is
 *   { format, version, fleetId, events: [...], manifest: { …, signature } }
 * with one event per line. An engine without the full export (or a fleet it
 * can't do it for) gets the older signed export instead.
 */
export async function buildAuditExport(
  fleetId: string,
  onProgress: (done: number, total: number) => void,
  opts: { fetchPage?: FetchExportPage; isCancelled?: () => boolean; wait?: (ms: number) => Promise<void> } = {},
): Promise<AuditExportFile | null> {
  const fetchPage = opts.fetchPage ?? ((id, cursor) => exportAuditFullPage(id, cursor));
  const wait = opts.wait ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const cancelled = () => opts.isCancelled?.() === true;
  /** A page, retried while the engine is busy; null once the export is cancelled. */
  const get = async (cursor?: { fromSeq: number; toSeq: number }): Promise<AuditExportPage | null> => {
    for (let attempt = 0; ; attempt++) {
      if (cancelled()) return null;
      try {
        return await fetchPage(fleetId, cursor);
      } catch (e) {
        if (attempt >= RETRIES || !(e instanceof WhiteRoomApiError) || !RETRYABLE.has(e.status ?? 0)) throw e;
        // Waited in short steps, so a cancel stops it straight away.
        for (let left = RETRY_WAIT_MS * (attempt + 1); left > 0; left -= WAIT_STEP_MS) {
          if (cancelled()) return null;
          await wait(Math.min(WAIT_STEP_MS, left));
        }
      }
    }
  };

  let page: AuditExportPage | null;
  try {
    page = await get();
  } catch (e) {
    // An older engine doesn't know the action (400); 409 is a fleet whose
    // history isn't stored yet; this 403 is an engine that wants the
    // dashboard's service secret before this dashboard sends one. All still
    // get the signed export they had; any other refusal is an error.
    if (e instanceof WhiteRoomApiError && (e.status === 409 || (e.status === 403 && e.reason === DASHBOARD_ONLY_REASON) || (e.status === 400 && e.reason === 'Unknown action.'))) {
      const signed = await exportAuditSigned(fleetId);
      return { blob: new Blob([JSON.stringify(signed, null, 2)], { type: 'application/json' }), events: null };
    }
    throw e;
  }
  if (!page) return null;

  // The head the first page pinned: every later page must be for the same one.
  const pinned = page.toSeq;
  const pinnedFirst = page.firstSeq;
  const total = Math.max(0, page.toSeq - page.firstSeq + 1);
  const parts: BlobPart[] = [`{"format":"whiteroom-audit-export","version":1,"fleetId":${JSON.stringify(fleetId)},"events":[\n`];
  let done = 0;
  // The seq the next event must have: events come one after another, none missing.
  let expect = page.firstSeq;
  let lastHash: string | null = null;
  for (;;) {
    for (const e of page.events) {
      if (e.seq !== expect) throw new AuditExportProblem('The export is missing events.', 'some events are missing');
      expect++;
      lastHash = typeof e.hash === 'string' ? e.hash : null;
    }
    if (page.events.length > 0) {
      parts.push(new Blob([(done > 0 ? ',\n' : '') + page.events.map((e) => JSON.stringify(e)).join(',\n')]));
      done += page.events.length;
    }
    onProgress(Math.min(done, total), total);
    if (page.nextFromSeq === null) break;
    if (cancelled()) return null;
    // Each page must move forward within the pinned range, right after its last event, or this would never end.
    if (page.events.length === 0 || page.nextFromSeq !== expect || page.nextFromSeq > page.toSeq) throw new Error('The export stopped moving forward.');
    page = await get({ fromSeq: page.nextFromSeq, toSeq: pinned });
    if (!page) return null;
    if (page.toSeq !== pinned || page.firstSeq !== pinnedFirst) throw new Error('The export changed part-way through.');
  }
  const m = page.manifest;
  if (!m) throw new AuditExportProblem('The export ended without its signature.', 'it doesn’t match WhiteRoom’s signature');
  // What was collected must be exactly what WhiteRoom signed for. The signed
  // head hash is the last event's: content swapped in under the right seq doesn't pass.
  const headOk = m.headSeq === expect - 1 && m.headHash === lastHash;
  if (m.firstSeq !== page.firstSeq || m.headSeq !== pinned || m.count !== done || !headOk) {
    throw new AuditExportProblem('The export doesn’t match its signature.', 'it doesn’t match WhiteRoom’s signature');
  }
  parts.push(`\n],"manifest":${JSON.stringify(m, null, 2)}}\n`);
  return { blob: new Blob(parts, { type: 'application/json' }), events: done };
}
