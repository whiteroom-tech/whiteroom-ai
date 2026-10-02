// Collects Content-Security-Policy violation reports (the report-only script
// policy, lib/csp.ts) into the server logs, so violations can be seen before
// the policy is enforced. Logs only the directive and what was blocked: no
// page URLs with query strings, no cookies. Anyone can post here, so the body
// is capped and nothing is stored.

const MAX_BYTES = 8 * 1024;

export async function POST(req: Request): Promise<Response> {
  const raw = await req.arrayBuffer();
  if (raw.byteLength > MAX_BYTES) return new Response(null, { status: 413 });
  try {
    const parsed = JSON.parse(new TextDecoder().decode(raw)) as unknown;
    // report-uri sends { "csp-report": {...} }; the Reporting API sends [{ body: {...} }].
    const reports = Array.isArray(parsed) ? parsed.map((r) => r?.body) : [(parsed as { 'csp-report'?: unknown })?.['csp-report']];
    for (const r of reports.slice(0, 5)) {
      if (!r || typeof r !== 'object') continue;
      const o = r as Record<string, unknown>;
      const directive = String(o['violated-directive'] ?? o.effectiveDirective ?? '').slice(0, 80);
      const blocked = String(o['blocked-uri'] ?? o.blockedURL ?? '').split('?')[0].slice(0, 200);
      const page = String(o['document-uri'] ?? o.documentURL ?? '').split('?')[0].slice(0, 200);
      console.warn(`[csp] ${directive} blocked ${blocked || '(inline)'} on ${page}`);
    }
  } catch {
    // Not JSON: ignore.
  }
  return new Response(null, { status: 204 });
}
