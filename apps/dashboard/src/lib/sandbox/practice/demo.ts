// The pre-flight's sample report (§7 Demo): a fixed, made-up result shown in
// place of a test, so nothing runs and nothing counts down. It shows every row
// status: Passed (Enforce and Watch), Didn't pass, Not set up, Not checked.
// /dev/practice builds its states from the same checks.

import type { PracticeCheck, PracticeReport, PracticeResult, PracticeRun } from './types';
import { CLI_VERSION } from './model';

/** A check as the engine reports it: passed in every run unless `extra` says otherwise. */
export const demoCheck = (id: string, label: string, scenario: string, observer: PracticeCheck['observer'], extra: Partial<PracticeCheck> = {}): PracticeCheck => ({
  id, label, scenario, observer, required: true, status: 'passed', reason: null, testProblem: false, summary: 'Passed in 3 of 3 runs.', fix: null, ...extra,
});

export const DEMO_AGENT_CHECKS: PracticeCheck[] = [
  demoCheck('a.result', 'Finishes a job correctly', 'Finishes a job correctly', 'records'),
  demoCheck('b.baseline', 'Right result on a long task', 'Handles a long task', 'records'),
  demoCheck('b.result', 'Right result after its memory fills up', 'Handles a long task', 'records'),
  demoCheck('b.carries_on', 'Carries on after WhiteRoom saves a summary', 'Handles a long task', 'whiteroom'),
  demoCheck('b.no_redo', 'Doesn’t redo finished work', 'Handles a long task', 'records'),
  demoCheck('c.timeout', 'Saves once when a tool times out', 'Handles a failing tool', 'records'),
  demoCheck('c.keeps_failing', 'Stops when a tool keeps failing', 'Handles a failing tool', 'records'),
];

const control = (id: string, label: string, mode: string | null, summary: string, extra: Partial<PracticeCheck> = {}) =>
  demoCheck(id, label, 'Your controls', 'whiteroom', { mode, summary, agents: 'all', setup: 'ok', ...extra });

const DEMO_FLEET = 'your-fleet';
const DEMO_AGENT = 'support-bot';

/** The sample report: one agent row fails, no spend cap is set, the tool list can't be checked, Watch passes. */
export const DEMO_REPORT: PracticeReport = {
  testVersion: 2, verdict: 'not_passed', runs: 3, sample: false, scope: null,
  checks: [
    ...DEMO_AGENT_CHECKS.map((c) => (c.id === 'c.timeout' ? {
      ...c, status: 'failed' as const, reason: 'key_not_reused', summary: 'Passed in 2 of 3 runs.',
      fix: 'Your agent changed the operation key when it retried a save, so the save could have happened twice. Fix: create the key once per action and send the same key on every retry.',
    } : c)),
    control('ctl.pause_stop', 'Pause and Stop', null, 'Paused and stopped: the next calls were refused. Only a person’s resume let the next one through.'),
    control('ctl.loop_breaker.gr_loop', 'Loop breaker', 'Enforce', 'The 3rd identical call was blocked.'),
    control('ctl.call_rate.gr_rate', 'Call rate', 'Watch', 'Let through and recorded.'),
    control('ctl.tool_list.gr_tools', 'Tool list', 'Enforce', 'Not checked: your agent’s tools are named differently.', { required: false, status: 'unsupported' }),
  ],
  how: { memoryLimitAdjusted: false },
  tested: {
    fleet: DEMO_FLEET, agent: DEMO_AGENT, modelRequested: 'claude-haiku-4-5', modelsUsed: ['claude-haiku-4-5'], adapter: 'node wr-adapter.mjs', cli: CLI_VERSION,
    provider: 'anthropic', proxyKeyDisplayPrefix: null, keyHint: null,
  },
};

export const DEMO_RUN: PracticeRun = {
  id: 'demo', lifecycle: 'finished', verdict: DEMO_REPORT.verdict, endReason: null, sourceFleetId: DEMO_FLEET, agentId: DEMO_AGENT, sample: false, runs: 3, scope: null,
  provider: 'anthropic', proxyKeyDisplayPrefix: null, keyHint: null, createdAt: '2026-10-28T12:00:00Z', startedAt: null, endedAt: null, codeExpiresAt: null, codeTriesLeft: null, progress: null,
};

export const DEMO_RESULT: PracticeResult = { id: 'demo', lifecycle: 'finished', verdict: DEMO_REPORT.verdict, report: DEMO_REPORT, detailsKeptUntil: null, summaryKeptUntil: null };
