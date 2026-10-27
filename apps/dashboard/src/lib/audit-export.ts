import { exportAuditFullPage, exportAuditSigned, WhiteRoomApiError } from '@/lib/whiteroom/client';
import type { AuditExportPage } from '@/lib/whiteroom/types';

/** How a page fetch is made; the client's by default, swapped in tests. */
export type FetchExportPage = (fleetId: string, cursor?: { fromSeq: number; toSeq: number }) => Promise<AuditExportPage>;

export interface AuditExportFile {
  blob: Blob;
  /** Events in the file; null for the older, shorter export. */
  events: number | null;
}

/** Busy, rate-limited or briefly unreachable: worth a short wait and another try. */
const RETRYABLE = new Set([429, 502, 503]);
const RETRIES = 3;
const RETRY_WAIT_MS = 5_000;

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
  const get = async (cursor?: { fromSeq: number; toSeq: number }) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fetchPage(fleetId, cursor);
      } catch (e) {
        if (attempt >= RETRIES || !(e instanceof WhiteRoomApiError) || !RETRYABLE.has(e.status ?? 0)) throw e;
        await wait(RETRY_WAIT_MS * (attempt + 1));
      }
    }
  };

  let page: AuditExportPage;
  try {
    page = await get();
  } catch (e) {
    // An older engine doesn't know the action (400); 409 is a fleet whose
    // history isn't stored yet. Both still get the signed export they had.
    if (e instanceof WhiteRoomApiError && (e.status === 409 || (e.status === 400 && e.reason === 'Unknown action.'))) {
      const signed = await exportAuditSigned(fleetId);
      return { blob: new Blob([JSON.stringify(signed, null, 2)], { type: 'application/json' }), events: null };
    }
    throw e;
  }

  const total = Math.max(0, page.toSeq - page.firstSeq + 1);
  const parts: BlobPart[] = [`{"format":"whiteroom-audit-export","version":1,"fleetId":${JSON.stringify(fleetId)},"events":[\n`];
  let done = 0;
  for (;;) {
    if (page.events.length > 0) {
      parts.push(new Blob([(done > 0 ? ',\n' : '') + page.events.map((e) => JSON.stringify(e)).join(',\n')]));
      done += page.events.length;
    }
    onProgress(Math.min(done, total), total);
    if (page.nextFromSeq === null) break;
    if (opts.isCancelled?.()) return null;
    // Each page must move forward within the pinned range, or this would never end.
    if (!(page.nextFromSeq > page.fromSeq && page.nextFromSeq <= page.toSeq)) throw new Error('The export stopped moving forward.');
    page = await get({ fromSeq: page.nextFromSeq, toSeq: page.toSeq });
  }
  if (!page.manifest) throw new Error('The export ended without its signature.');
  parts.push(`\n],"manifest":${JSON.stringify(page.manifest, null, 2)}}\n`);
  return { blob: new Blob(parts, { type: 'application/json' }), events: done };
}

/** Saves a Blob through a temporary link. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Revoked after the click has been handled, so a large file isn't cut off.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
