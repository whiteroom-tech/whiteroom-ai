// The Sandbox test report a customer downloads: one self-contained HTML page,
// plain words first for anyone, the exact record below for engineers. Built
// from the same run status the page shows, so the two can't disagree.

import { eventModel } from '@/lib/activity';
import type { AuditEntry } from '@/lib/whiteroom/types';
import { withRunMode, type RunStatusResult } from './api';

export const HANDOVER_TYPES = new Set(['handover', 'self_handover', 'paired_handover']);

const CHECKS = [
  { id: 'core.connect', label: 'Your agent connects', meaning: 'Its calls reach the model through WhiteRoom and come back normally.' },
  { id: 'core.handoff', label: 'It hands over when the shift ends', meaning: 'When a shift ends, WhiteRoom keeps the agent’s context compact instead of letting it grow.' },
  { id: 'core.resume', label: 'It picks up where it left off', meaning: 'After the handover, the agent’s next call works and it keeps going.' },
] as const;

/** The check names the page and the report share. */
export function checkLabel(controlId: string, name: string): string {
  return CHECKS.find((c) => c.id === controlId)?.label ?? name;
}

export type CheckResult = 'passed' | 'failed' | 'not yet';

export interface TestReport {
  testId: string;
  fleetId: string;
  mode: 'demo' | 'connected';
  generatedAt: string;
  passed: number;
  checks: { id: string; label: string; meaning: string; result: CheckResult; at: string | null; detail: string | null }[];
  agents: { agentId: string; calls: number; tokens: number; shifts: number; shiftMinutes: number }[];
  calls: number;
  tokens: number;
  handovers: number;
  firstEventAt: string | null;
  lastEventAt: string | null;
  /** First and last call: the agent's own activity, without later rests or watchdog handovers. */
  firstCallAt: string | null;
  lastCallAt: string | null;
  events: { at: string; type: string; agentId: string | null; text: string }[];
}

/** The fresh status when it's still this test, else the page's last copy of it. */
export function reportSource(latest: RunStatusResult, current: RunStatusResult): RunStatusResult {
  return latest.sandboxId && latest.sandboxId === current.sandboxId ? withRunMode(latest, current.mode) : current;
}

export function buildTestReport(run: RunStatusResult, now: number = Date.now()): TestReport {
  const mode = run.mode === 'demo' ? 'demo' : 'connected';
  const checks = CHECKS.map((c) => {
    const control = run.controls?.find((x) => x.controlId === c.id);
    const ev = mode === 'demo' ? control?.result?.demoEvidence : control?.result?.liveEvidence;
    const result: CheckResult = ev?.status === 'observed' ? 'passed' : ev?.status === 'failed' ? 'failed' : 'not yet';
    return { id: c.id, label: c.label, meaning: c.meaning, result, at: ev?.timestamp ?? null, detail: ev?.diagnostic ?? null };
  });
  const agents = (run.agents ?? []).map((a) => ({ agentId: a.agentId, calls: a.totalTasks, tokens: a.totalTokens, shifts: a.watchCount, shiftMinutes: a.watchMinutes }));
  const log = [...(run.auditLog ?? [])].filter((e) => Number.isFinite(Date.parse(e.timestamp))).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  return {
    testId: run.sandboxId ?? '',
    fleetId: run.sandboxId ? `sandbox-${run.sandboxId}` : '',
    mode,
    generatedAt: new Date(now).toISOString(),
    passed: checks.filter((c) => c.result === 'passed').length,
    checks,
    agents,
    calls: agents.reduce((n, a) => n + a.calls, 0),
    tokens: agents.reduce((n, a) => n + a.tokens, 0),
    handovers: log.filter((e) => HANDOVER_TYPES.has(e.type)).length,
    firstEventAt: log[0]?.timestamp ?? null,
    lastEventAt: log.at(-1)?.timestamp ?? null,
    firstCallAt: log.find((e) => e.type === 'task_complete')?.timestamp ?? null,
    lastCallAt: log.findLast((e) => e.type === 'task_complete')?.timestamp ?? null,
    // Calls and handovers in plain words; the internal task label and engine wording mean nothing to a reader.
    events: log.map((e) => ({ at: e.timestamp, type: e.type, agentId: e.agentId, text: e.type === 'task_complete' ? 'made a call' : HANDOVER_TYPES.has(e.type) ? 'handed over its work, keeping its context compact' : eventModel(e as unknown as AuditEntry).said })),
  };
}

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Readable times are in the downloader's zone, named once in the header; the
// technical section stays UTC.
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) : '—');
const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' }).toLowerCase();
const zoneName = (iso: string) => new Intl.DateTimeFormat('en-US', { timeZoneName: 'long' }).formatToParts(new Date(iso)).find((p) => p.type === 'timeZoneName')?.value ?? 'local time';

/** "8 min 38 s". */
export function spanText(from: string | null, to: string | null): string {
  if (!from || !to) return '—';
  const s = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** The plain-language paragraph: what each check found, and no more. */
export function summaryText(r: TestReport): string {
  const names = r.agents.map((a) => a.agentId).join(', ') || 'Your agent';
  const [connect, handoff, resume] = r.checks;
  const why = (c: { detail: string | null }) => (c.detail ? ` (${c.detail})` : '');
  if (connect.result === 'failed') return `${names} reached WhiteRoom, but its calls didn’t come back normally${why(connect)}.`;
  if (connect.result !== 'passed') return `${names} hasn’t completed a call through WhiteRoom in this test yet, so nothing could be checked.`;
  const parts = [`${names} made ${r.calls} call${r.calls === 1 ? '' : 's'} through WhiteRoom${r.calls > 1 ? ` over ${spanText(r.firstCallAt, r.lastCallAt)}` : ''}, and they came back normally.`];
  const minutes = r.agents[0]?.shiftMinutes;
  if (handoff.result === 'failed') return [...parts, `When its shift ended, the handover didn’t complete${why(handoff)}.`].join(' ');
  if (handoff.result !== 'passed') return [...parts, 'Its shift hadn’t ended by the time of this report, so the handover wasn’t checked.'].join(' ');
  parts.push(`When its${minutes ? ` ${minutes}-minute` : ''} shift ended, WhiteRoom handed its work over ${r.handovers > 1 ? `${r.handovers} times` : 'once'}, keeping its context compact.`);
  parts.push(resume.result === 'passed' ? 'The agent carried on from where it left off.'
    : resume.result === 'failed' ? `Its next call after the handover didn’t work${why(resume)}.`
    : 'Its next call after the handover hadn’t arrived yet.');
  return parts.join(' ');
}

const ICON: Record<CheckResult, string> = { passed: '✓', failed: '✕', 'not yet': '○' };
const TONE: Record<CheckResult, string> = { passed: 'ok', failed: 'bad', 'not yet': 'wait' };
const RESULT_TEXT: Record<CheckResult, string> = { passed: 'Passed', failed: 'Failed', 'not yet': 'Not yet' };

export function reportHtml(r: TestReport): string {
  const verdict = r.passed === r.checks.length ? 'All 3 checks passed' : `${r.passed} of ${r.checks.length} checks passed`;
  // Every non-call event, plus the first and last call.
  const calls = r.events.flatMap((e, i) => (e.type === 'task_complete' ? [i] : []));
  const keyEvents = r.events.filter((e, i) => e.type !== 'task_complete' || i === calls[0] || i === calls.at(-1));
  const data = JSON.stringify(r, null, 2);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhiteRoom test report · ${esc(r.testId.slice(0, 8))}</title>
<style>
:root{--bg:#F6F9FD;--card:#fff;--ink:#0B1220;--ink2:#3C4A64;--line:#DCE3EE;--ok:#0A7A55;--bad:#B42318;--wait:#8A6100;--accent:#0A82A1}
@media (prefers-color-scheme:dark){:root{--bg:#070B14;--card:#0E1524;--ink:#EAF1FF;--ink2:#A9B8D4;--line:#1E2A40;--ok:#3DD68C;--bad:#FF6B6B;--wait:#FFB454;--accent:#38E1FF}}
@media print{:root{--bg:#fff;--card:#fff;--ink:#000;--ink2:#333;--line:#ccc}details{display:block}details>*{display:block}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 Inter,system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 16px 48px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px}
.muted{color:var(--ink2)}.mono{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-top:14px}
.stat{border:1px solid var(--line);border-radius:8px;padding:10px 12px}.stat b{display:block;font-size:20px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px 10px;border-top:1px solid var(--line);vertical-align:top}th{font-size:12px;color:var(--ink2);font-weight:600;border-top:0}
.ok{color:var(--ok)}.bad{color:var(--bad)}.wait{color:var(--wait)}
details{margin-top:12px}summary{cursor:pointer;font-weight:600}pre{white-space:pre-wrap;word-break:break-all;margin:10px 0 0}
</style></head><body><main>
<p class="muted mono">WHITEROOM · SANDBOX TEST REPORT</p>
<h1 class="${r.passed === r.checks.length ? 'ok' : r.checks.some((c) => c.result === 'failed') ? 'bad' : 'wait'}">${esc(verdict)}</h1>
<p class="muted">Test ${esc(r.testId)} · ${r.mode === 'demo' ? 'Demo run' : 'Your agent'} · Report made ${esc(when(r.generatedAt))} · Times below are ${esc(zoneName(r.generatedAt))}</p>

<div class="card">
<p>${esc(summaryText(r))}</p>
<div class="stats">
<div class="stat"><b>${r.calls}</b><span class="muted">calls</span></div>
<div class="stat"><b>${r.tokens.toLocaleString('en-US')}</b><span class="muted">tokens</span></div>
<div class="stat"><b>${r.handovers}</b><span class="muted">handover${r.handovers === 1 ? '' : 's'}</span></div>
<div class="stat"><b>${esc(r.calls > 1 ? spanText(r.firstCallAt, r.lastCallAt) : '—')}</b><span class="muted">first to last call</span></div>
</div></div>

<h2>The three checks</h2>
<div class="card"><table><thead><tr><th></th><th>Check</th><th>What it means</th><th>Result</th></tr></thead><tbody>
${r.checks.map((c) => `<tr><td class="${TONE[c.result]}">${ICON[c.result]}</td><td>${esc(c.label)}</td><td class="muted">${esc(c.meaning)}</td><td class="${TONE[c.result]}">${RESULT_TEXT[c.result]}${c.at ? ` <span class="muted mono">${esc(clock(c.at))}</span>` : ''}${c.detail && c.result === 'failed' ? `<br><span class="muted">${esc(c.detail)}</span>` : ''}</td></tr>`).join('\n')}
</tbody></table></div>

<h2>What happened</h2>
<div class="card"><table><thead><tr><th>Time</th><th>Event</th></tr></thead><tbody>
${keyEvents.map((e) => `<tr><td class="mono">${esc(clock(e.at))}</td><td>${esc(e.agentId ? `${e.agentId} ${e.text}` : e.text)}</td></tr>`).join('\n') || '<tr><td colspan="2" class="muted">No events recorded.</td></tr>'}
</tbody></table>
<p class="muted">First and last call, plus every shift, handover and rest. The full list is in the technical details below.</p></div>

<p class="muted">These checks show your agent works through WhiteRoom. They don’t check that its answers are correct. Use them to help decide, not as a certificate.</p>

<h2>Technical details</h2>
<div class="card">
<table><tbody>
<tr><th>Test id</th><td class="mono">${esc(r.testId)}</td></tr>
<tr><th>Fleet (x-whiteroom-fleet)</th><td class="mono">${esc(r.fleetId)}</td></tr>
<tr><th>Mode</th><td>${esc(r.mode)}</td></tr>
<tr><th>First / last call</th><td class="mono">${esc(r.firstCallAt ?? '—')} → ${esc(r.lastCallAt ?? '—')}</td></tr>
<tr><th>First / last event</th><td class="mono">${esc(r.firstEventAt ?? '—')} → ${esc(r.lastEventAt ?? '—')}</td></tr>
${r.checks.map((c) => `<tr><th>${esc(c.id)}</th><td class="mono">${esc(c.result)}${c.at ? ` · ${esc(c.at)}` : ''}${c.detail ? ` · ${esc(c.detail)}` : ''}</td></tr>`).join('\n')}
</tbody></table>
<h2>Agents</h2>
<table><thead><tr><th>Agent (x-whiteroom-agent)</th><th>Calls</th><th>Tokens</th><th>Shifts</th><th>Shift length</th></tr></thead><tbody>
${r.agents.map((a) => `<tr><td class="mono">${esc(a.agentId)}</td><td>${a.calls}</td><td>${a.tokens.toLocaleString('en-US')}</td><td>${a.shifts}</td><td>${a.shiftMinutes} min</td></tr>`).join('\n') || '<tr><td colspan="5" class="muted">No agents connected.</td></tr>'}
</tbody></table>
<details><summary>Every event (${r.events.length})</summary>
<table><thead><tr><th>Time (UTC)</th><th>Type</th><th>Agent</th></tr></thead><tbody>
${r.events.map((e) => `<tr><td class="mono">${esc(e.at)}</td><td class="mono">${esc(e.type)}</td><td class="mono">${esc(e.agentId ?? '')}</td></tr>`).join('\n')}
</tbody></table></details>
<details><summary>Data (JSON)</summary><pre class="mono">${esc(data)}</pre></details>
</div>
</main></body></html>`;
}

/** "whiteroom-test-report-2026-10-04-d4ccb85c.html". */
export function reportFileName(r: TestReport): string {
  return `whiteroom-test-report-${r.generatedAt.slice(0, 10)}-${r.testId.slice(0, 8)}.html`;
}
