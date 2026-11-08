// Sandbox › report › Download report: the eight rows as one static HTML page,
// the same words as the page and Copy summary, keys and IDs hidden.
import { describe, expect, it } from 'vitest';
import { CHECK_IDS, checkStateOf, type CheckState } from '@/lib/sandbox/checks';
import { rowsHeadline, rowsSummary, sandboxRows } from '@/lib/sandbox/sandbox-rows';
import { SANDBOX_REPORT_NOTE, sandboxReportFileName, sandboxReportHtml } from '@/lib/sandbox/sandbox-report';
import { REPORT_CSP } from '@/lib/sandbox/practice/report';
import { scrub } from '@/lib/sandbox/check-report';

const KEY = `sk-wr-${'a'.repeat(40)}`;
const NP = 'Not proven: we stopped your agent and let it go, then your agent made no new calls, so we can’t tell if it carried on or crashed. Run a longer task to check this.';

function state(): CheckState {
  const detail: Record<string, [string, string]> = {
    spend_cap: ['passed', 'We blocked a call → it didn’t retry that call and carried on.'],
    loop_rate: ['not_triggered', 'Not triggered by this run.'],
    allowlists_keywords: ['failed', `We blocked a call to https://proxy.whiteroom.tech/${KEY} → your agent retried it 4 times within 5 s. Fix: back off.`],
    pause_stop: ['not_checked', NP],
    long_task: ['passed', 'WhiteRoom handed over after 2 calls → your agent’s next call carried on.'],
    provider_errors: ['passed', 'We returned a provider error (529) → it retried 1 time, backing off, then carried on.'],
    finishes_correctly: ['not_checked', 'Not checked: run practice tasks to check this.'],
  };
  return checkStateOf({
    window: { id: 'sbc_1a2b3c4d-0000', startedAt: '2026-11-07T23:00:00Z', endedAt: '2026-11-07T23:06:00Z', stage: 'done', injectErrors: true, calls: 24, agentId: '<b>support-bot</b>' },
    checks: CHECK_IDS.map((id) => ({ id, label: id, status: detail[id][0], detail: detail[id][1], ...(id === 'pause_stop' && { notProven: true }) })),
    rules: [],
  })!;
}

describe('Download report', () => {
  const rows = sandboxRows(state());
  const html = sandboxReportHtml(rows, { agent: '<b>support-bot</b>', calls: 24, when: 'today at 11:06 pm', notes: ['Also called during this check: billing-agent (not checked).'] });

  it('has every row, its state and the fix, in the same words as the page and Copy summary', () => {
    expect(html).toContain(rowsHeadline(rows).headline);
    for (const r of rows) expect(html).toContain(r.name);
    // Named once, beside the row's name: the line doesn't repeat it.
    expect(html).toContain('Not proven</span><br>We stopped your agent and let it go');
    expect(html).not.toContain('Not proven: we stopped');
    expect(html).toMatch(/<td class="wait">\?<\/td>/);
    expect(html).toContain('What happened:');
    expect(html).toContain('How to fix:');
    expect(html).toContain('today at 11:06 pm');
    expect(html).toContain('billing-agent (not checked)');
    expect(html).toContain(SANDBOX_REPORT_NOTE);
    // The rows say what Copy summary says.
    const summary = rowsSummary(rows, { when: 'today at 11:06 pm', calls: 24 });
    for (const r of rows) if (r.line) expect(summary).toContain(scrub(r.line).slice(0, 40));
  });

  it('hides keys as Copy summary does, escapes what it shows, and loads nothing', () => {
    expect(html).not.toContain(KEY);
    expect(html).toContain('[hidden]');
    expect(html).not.toContain('<b>support-bot</b>');
    expect(html).toContain('&lt;b&gt;support-bot&lt;/b&gt;');
    expect(html).toContain(`content="${REPORT_CSP}"`);
    expect(html).not.toMatch(/<script|<link|<img|src=|href=/i);
  });

  it('is named by the day it ended and the check’s short id', () => {
    expect(sandboxReportFileName('sbc_1a2b3c4d-0000', '2026-11-07T23:06:00Z', 'UTC')).toBe('whiteroom-sandbox-check-2026-11-07-1a2b3c.html');
    expect(sandboxReportFileName(undefined, '2026-11-07T23:06:00Z', 'UTC')).toBe('whiteroom-sandbox-check-2026-11-07.html');
    // The day the report's times are in: 04:06 UTC on the 8th is still the 7th in New York.
    expect(sandboxReportFileName('sbc_1a2b3c', '2026-11-08T04:06:00Z', 'America/New_York')).toBe('whiteroom-sandbox-check-2026-11-07-1a2b3c.html');
    expect(sandboxReportFileName('sbc_1a2b3c', '2026-11-08T04:06:00Z', 'Europe/Berlin')).toBe('whiteroom-sandbox-check-2026-11-08-1a2b3c.html');
    // No end time yet (a report read before it was stored): today's date.
    expect(sandboxReportFileName('sbc_1a2b3c', null, 'UTC')).toMatch(/^whiteroom-sandbox-check-\d{4}-\d{2}-\d{2}-1a2b3c\.html$/);
  });
});
