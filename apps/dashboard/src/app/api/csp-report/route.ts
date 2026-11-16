// Collects Content-Security-Policy violation reports (the script policy,
// lib/csp.ts) into the server logs, so anything it blocks can be seen. Logs
// only the directive and what was blocked: no page URLs with query strings,
// no cookies. Anyone can post here, so the body is capped and nothing is
// stored.

import { readCapped } from '@/lib/read-capped';

const MAX_BYTES = 8 * 1024;

/** A report field for the log: control characters out (no forged log lines), no query string, bounded. */
const field = (v: unknown, max: number) => String(v ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').split('?')[0].slice(0, max);

export async function POST(req: Request): Promise<Response> {
  const raw = await readCapped(req, MAX_BYTES);
  if (!raw) return new Response(null, { status: 413 });
  try {
    const parsed = JSON.parse(new TextDecoder().decode(raw)) as unknown;
    // report-uri sends { "csp-report": {...} }; the Reporting API sends [{ body: {...} }].
    const reports = Array.isArray(parsed) ? parsed.map((r) => r?.body) : [(parsed as { 'csp-report'?: unknown })?.['csp-report']];
    for (const r of reports.slice(0, 5)) {
      if (!r || typeof r !== 'object') continue;
      const o = r as Record<string, unknown>;
      const directive = field(o['violated-directive'] ?? o.effectiveDirective, 80);
      const blocked = field(o['blocked-uri'] ?? o.blockedURL, 200);
      const page = field(o['document-uri'] ?? o.documentURL, 200);
      console.warn(`[csp] ${directive} blocked ${blocked || '(inline)'} on ${page}`);
    }
  } catch {
    // Not JSON: ignore.
  }
  return new Response(null, { status: 204 });
}
