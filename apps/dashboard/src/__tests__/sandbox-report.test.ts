import { describe, expect, it } from 'vitest';
import { buildTestReport, reportFileName, reportHtml, spanText, summaryText } from '@/lib/sandbox/report';
import type { RunStatusResult } from '@/lib/sandbox/api';

// A connected test like a real one: 20 calls, one handover, all three checks.
const t = (s: number) => new Date(Date.UTC(2026, 9, 4, 19, 6, 0) + s * 1000).toISOString();
const evidence = (s: number) => ({ result: { liveEvidence: { status: 'observed' as const, timestamp: t(s), requestId: 'r', testedRevision: 1, testedPolicyVersion: 1 } } });
const control = (controlId: string, s: number | null) => ({ controlId, name: controlId, ...(s === null ? { result: {} } : evidence(s)) });
function run(over: Partial<RunStatusResult> = {}): RunStatusResult {
  return {
    sandboxId: '00000000-test-0000-0000-000000000000',
    mode: 'connected',
    controls: [control('core.connect', 25), control('core.handoff', 143), control('core.resume', 148)] as unknown as RunStatusResult['controls'],
    agents: [{ agentId: 'demo-agent', role: 'worker', status: 'working', watchMinutes: 2, watchCount: 2, totalTasks: 20, totalTokens: 24310, pairedWith: null, currentWatch: null }],
    auditLog: [
      { id: 'e1', timestamp: t(0), type: 'watch_start', agentId: 'demo-agent' },
      ...Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, timestamp: t(25 + i * 16), type: 'task_complete', agentId: 'demo-agent', taskName: 'llm_call' })),
      { id: 'h1', timestamp: t(143), type: 'self_handover', agentId: 'demo-agent' },
    ],
    ...over,
  };
}

describe('sandbox test report', () => {
  it('reads the checks from the same live evidence the page shows', () => {
    const r = buildTestReport(run());
    expect(r.passed).toBe(3);
    expect(r.checks.map((c) => c.result)).toEqual(['passed', 'passed', 'passed']);
    expect(r).toMatchObject({ calls: 20, tokens: 24310, handovers: 1, fleetId: 'sandbox-00000000-test-0000-0000-000000000000' });
  });

  it('says only what the passed checks support, in plain words', () => {
    expect(summaryText(buildTestReport(run()))).toBe(
      'demo-agent made 20 calls through WhiteRoom over 5 min 29 s, and they came back normally. When its 2-minute shift ended, WhiteRoom handed its work over once, keeping its context compact. The agent carried on from where it left off.');
    const early = buildTestReport(run({ controls: [control('core.connect', 25), control('core.handoff', null), control('core.resume', null)] as unknown as RunStatusResult['controls'] }));
    expect(early.passed).toBe(1);
    expect(summaryText(early)).toContain('the handover wasn’t checked');
    expect(summaryText(buildTestReport(run({ controls: [], agents: [], auditLog: [] })))).toContain('hasn’t completed a call');
  });

  it('uses demo evidence for a demo run', () => {
    const demo = run({ mode: 'demo', controls: [{ controlId: 'core.connect', name: 'x', result: { demoEvidence: { status: 'observed', timestamp: t(1) } } }] as unknown as RunStatusResult['controls'] });
    expect(buildTestReport(demo).checks[0].result).toBe('passed');
  });

  it('renders a self-contained page with the verdict, checks, key events and escaped data', () => {
    const html = reportHtml(buildTestReport(run({ agents: [{ ...run().agents![0], agentId: '<b>x</b>' }] })));
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('All 3 checks passed');
    expect(html).toContain('It picks up where it left off');
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toMatch(/<script|https?:\/\/(?!www\.w3)/);
    // Key events: first and last call plus the handover, not all 20 calls.
    const whatHappened = html.slice(html.indexOf('What happened'), html.indexOf('Technical details'));
    expect((whatHappened.match(/<tr><td class="mono">/g) ?? []).length).toBe(4);
  });

  it('names the file by date and test', () => {
    expect(reportFileName(buildTestReport(run(), Date.UTC(2026, 9, 4, 20)))).toBe('whiteroom-test-report-2026-10-04-00000000.html');
    expect(spanText(null, t(1))).toBe('—');
  });
});
