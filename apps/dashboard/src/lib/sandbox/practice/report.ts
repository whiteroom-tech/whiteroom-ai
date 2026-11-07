// The practice test report a customer downloads (spec §9.8): one static HTML
// page built in the browser, like lib/sandbox/report.ts. Allowlisted fields
// only: verdict, the seven rows (status and reason) with each row's check names
// and results, failed checks with their fix lines,
// runs, date, fleet, agent name and the disclaimer. Never what was tested,
// limits, call counts or when a tool failure fired. No script; a CSP meta
// blocks anything the page might otherwise load.

import { DISCLAIMER, fixLine, groupRows, headline, ROW_GROUPS, ROW_STATUS_LABEL, STATUS_LABEL } from './model';
import type { PracticeReport } from './types';
import { plural } from '@/lib/format';
import { formatInZone } from '@/lib/zone-time';

/** Control, C1 and bidi characters, which could make the file read differently from what it says (§9.7). */
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const esc = (s: unknown) => String(s ?? '').replace(UNSAFE, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const ROW_TONE = { passed: 'ok', failed: 'bad', not_set_up: 'wait', not_checked: 'wait' } as const;

export const REPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

/** Only full tests of the owner's own agent get a report (§14 Verdict: "report only for full own-agent runs"). */
export const canDownload = (r: PracticeReport) => !r.sample && !r.scope;

export function practiceReportHtml(id: string, r: PracticeReport, endedAt: string): string {
  const date = formatInZone(endedAt, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) || '—';
  const tone = r.verdict === 'passed' ? 'ok' : r.verdict === 'not_passed' ? 'bad' : 'wait';
  const rows = groupRows(r);
  const fixes = r.checks.filter((c) => c.required && c.status !== 'passed' && c.status !== 'unsupported').map((c) => ({ label: c.label, fix: fixLine(c, r) })).filter((c) => c.fix);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhiteRoom practice test · ${esc(id.slice(0, 6))}</title>
<style>
:root{--bg:#F6F9FD;--card:#fff;--ink:#0B1220;--ink2:#3C4A64;--line:#DCE3EE;--ok:#0A7A55;--bad:#B42318;--wait:#8A6100}
@media (prefers-color-scheme:dark){:root{--bg:#070B14;--card:#0E1524;--ink:#EAF1FF;--ink2:#A9B8D4;--line:#1E2A40;--ok:#3DD68C;--bad:#FF6B6B;--wait:#FFB454}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 Inter,system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:820px;margin:0 auto;padding:32px 16px 48px}h1{font-size:24px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px}
.muted{color:var(--ink2)}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 20px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px 10px;border-top:1px solid var(--line);vertical-align:top}th{font-size:12px;color:var(--ink2);font-weight:600;border-top:0}
.ok{color:var(--ok)}.bad{color:var(--bad)}.wait{color:var(--wait)}
</style></head><body><main>
<p class="muted">WHITEROOM · PRACTICE TEST REPORT</p>
<h1 class="${tone}">${esc(headline(r))}</h1>
<p class="muted">Fleet ${esc(r.tested.fleet)} · Agent ${esc(r.tested.agent)} · ${r.runs} ${plural(r.runs, 'run')} · ${esc(date)} · Test ${esc(id)}</p>
${ROW_GROUPS.map((g) => `<h2>${esc(g)}</h2>
<div class="card"><table><thead><tr><th>Check</th><th>Result</th></tr></thead><tbody>
${rows.filter((x) => x.row.group === g).map((x) => `<tr><td><strong>${esc(x.row.name)}</strong>${x.members.map((c) => `<br><span class="muted">${esc(c.mode ? `${c.label} · ${c.mode}` : c.label)}: ${esc(STATUS_LABEL[c.status])}</span>`).join('')}</td><td class="${ROW_TONE[x.status]}">${esc(ROW_STATUS_LABEL[x.status])}<br><span class="muted">${esc(x.reason)}</span></td></tr>`).join('\n')}
</tbody></table></div>`).join('\n')}
${fixes.length ? `<h2>${r.verdict === 'incomplete' ? 'What stopped the test' : 'What to fix'}</h2>
<div class="card">${fixes.map((c) => `<p><strong>${esc(c.label)}</strong><br>${esc(c.fix)}</p>`).join('\n')}</div>` : ''}
<p class="muted">${esc(DISCLAIMER)}</p>
</main></body></html>`;
}

/** "whiteroom-practice-test-2026-10-12-r-7f3a.html". */
export function practiceReportFileName(id: string, endedAt: string): string {
  return `whiteroom-practice-test-${endedAt.slice(0, 10)}-${id.slice(0, 6)}.html`;
}
