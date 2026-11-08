// The Sandbox check report a customer downloads: one static HTML page built in
// the browser from the same eight rows the page and Copy summary show, so the
// three can't disagree. Keys, URLs and IDs are hidden (scrub), as in Copy
// summary. No script; a CSP meta blocks anything the page might otherwise load.

import { scrub } from './check-report';
import { REPORT_CSP } from './practice/report';
import { callsText, ROW_GROUP_NAMES, rowsHeadline, STATE_WORDS, type RowState, type SandboxRow } from './sandbox-rows';

/** Control, C1 and bidi characters, which could make the file read differently from what it says. */
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g;
const esc = (s: unknown) => scrub(String(s ?? '')).replace(UNSAFE, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Each state's mark and colour, as on the page: ✓ passed or partly, ✕ didn't pass, ? not proven, – the rest. */
const MARK: Record<RowState, { text: string; tone: 'ok' | 'bad' | 'wait' | 'muted' }> = {
  passed: { text: '✓', tone: 'ok' }, partly: { text: '✓', tone: 'ok' }, failed: { text: '✕', tone: 'bad' }, not_proven: { text: '?', tone: 'wait' },
  not_checked: { text: '–', tone: 'muted' }, not_run_yet: { text: '–', tone: 'muted' }, not_set_up: { text: '–', tone: 'muted' },
};

export const SANDBOX_REPORT_NOTE = 'From your Sandbox, which never touches your live agents. Use it to help decide, not as a certificate.';

export interface SandboxReportMeta {
  /** The check's agent, when the engine names it. */
  agent: string | null;
  calls: number;
  /** When it ran, as the page says it ("today at 11:02 pm", or the live check and practice times). */
  when: string;
  /** The too-few-calls or restart line, when there is one. */
  lead?: string | null;
  /** The page's notes: another agent's practice run, other agents that called. */
  notes?: string[];
}

export function sandboxReportHtml(rows: SandboxRow[], o: SandboxReportMeta): string {
  const h = rowsHeadline(rows);
  const tone = h.tone === 'pass' ? 'ok' : h.tone === 'warn' ? 'bad' : '';
  const sub = [h.sub, o.agent, callsText(o.calls), o.when].filter(Boolean).join(' · ');
  const row = (r: SandboxRow) => {
    const m = MARK[r.state];
    const parts = r.parts.map((p) => `<br><span class="muted">${esc(p.label)}:</span> ${esc(p.text)}`).join('');
    const fix = r.fix ? `<p class="fix"><strong>What happened:</strong> ${esc(r.fix.happened)}<br><strong>How to fix:</strong> ${esc(r.fix.next)}</p>` : '';
    const note = r.note ? `<br><span class="muted">${esc(r.note)}</span>` : '';
    // The state is named beside the row's name, so a line that starts with it ("Not proven: …") doesn't repeat it.
    const word = STATE_WORDS[r.state];
    const line = r.line.startsWith(`${word}: `) ? r.line.slice(word.length + 2).replace(/^./, (c) => c.toUpperCase()) : r.line;
    return `<tr><td class="num">${esc(r.num)}</td><td class="${m.tone}">${m.text}</td><td><strong>${esc(r.name)}</strong> <span class="${m.tone}">${esc(word)}</span>${line ? `<br>${esc(line)}` : ''}${parts}${note}${fix}</td></tr>`;
  };
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhiteRoom Sandbox check</title>
<style>
:root{--bg:#F6F9FD;--card:#fff;--ink:#0B1220;--ink2:#3C4A64;--line:#DCE3EE;--ok:#0A7A55;--bad:#B42318;--wait:#8A6100}
@media (prefers-color-scheme:dark){:root{--bg:#070B14;--card:#0E1524;--ink:#EAF1FF;--ink2:#A9B8D4;--line:#1E2A40;--ok:#3DD68C;--bad:#FF6B6B;--wait:#FFB454}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 Inter,system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:820px;margin:0 auto;padding:32px 16px 48px}h1{font-size:24px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px}
.muted{color:var(--ink2)}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:6px 10px}
table{width:100%;border-collapse:collapse}td{text-align:left;padding:10px 8px;border-top:1px solid var(--line);vertical-align:top}tr:first-child td{border-top:0}
td.num{color:var(--ink2);font-family:ui-monospace,Menlo,monospace;width:2.5em}td.num+td{font-weight:700;width:1.5em}
.fix{margin:8px 0 0}.ok{color:var(--ok)}.bad{color:var(--bad)}.wait{color:var(--wait)}
</style></head><body><main>
<p class="muted">WHITEROOM · SANDBOX CHECK REPORT</p>
<h1 class="${tone}">${esc(h.headline)}</h1>
<p class="muted">${esc(sub)}</p>
${o.lead ? `<p>${esc(o.lead)}</p>` : ''}
${(['agent', 'guardrails'] as const).map((g) => `<h2>${esc(ROW_GROUP_NAMES[g].name)} <span class="muted">· ${esc(ROW_GROUP_NAMES[g].q)}</span></h2>
<div class="card"><table><tbody>
${rows.filter((r) => r.group === g).map(row).join('\n')}
</tbody></table></div>`).join('\n')}
${o.notes?.length ? `<p class="muted">${o.notes.map(esc).join('<br>')}</p>` : ''}
<p class="muted">${esc(SANDBOX_REPORT_NOTE)}</p>
</main></body></html>`;
}

/** "whiteroom-sandbox-check-2026-11-07-c_1a2b.html": the day it ended and the check's short id. */
export function sandboxReportFileName(windowId: string | undefined, endedAt: string | null | undefined): string {
  const day = (endedAt ?? new Date().toISOString()).slice(0, 10);
  const id = (windowId ?? '').replace(/^sbc_/, '').replace(/[^A-Za-z0-9]/g, '').slice(0, 6);
  return `whiteroom-sandbox-check-${day}${id ? `-${id}` : ''}.html`;
}
