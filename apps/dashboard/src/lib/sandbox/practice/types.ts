// Practice tests (sandbox readiness spec rev 5.6, §7): what the engine's
// /api/readiness routes return, as the dashboard reads them through its BFF.
// Shapes follow the engine's contract fixtures (src/__tests__/fixtures/practice).

export type PracticeLifecycle = 'draft' | 'active' | 'finalizing' | 'finished' | 'interrupted' | 'cancelled';
export type PracticeVerdict = 'passed' | 'not_passed' | 'incomplete';
export type PracticeCheckStatus = 'passed' | 'failed' | 'not_tested' | 'unsupported' | 'error';
export type PracticeObserver = 'whiteroom' | 'records' | 'cli';

/** Provider errors on a practice task, as WhiteRoom saw them (perf_calls). */
export interface PracticeFailedCalls {
  count: number;
  last: { status: number | null; reason: 'upstream_error' | 'upstream_unreachable' } | null;
}

export interface PracticeCheck {
  id: string;
  label: string;
  scenario: string;
  observer: PracticeObserver;
  /** False for a control that isn't checked: it never turns Passed into Didn't finish. */
  required: boolean;
  status: PracticeCheckStatus;
  reason: string | null;
  testProblem: boolean;
  /** Agent checks: runs passed. Control checks: what happened, or why it wasn't checked. */
  summary: string;
  fix: string | null;
  mode?: string | null;
  agents?: 'all' | string[];
  failedCalls?: PracticeFailedCalls;
}

export interface PracticeReport {
  testVersion: number;
  verdict: PracticeVerdict;
  runs: number;
  sample: boolean;
  scope: string[] | null;
  checks: PracticeCheck[];
  how: { memoryTokens: Record<string, number>; memoryLimitAdjusted: boolean };
  tested: { fleet: string; agent: string; modelRequested: string | null; modelsUsed: string[]; adapter: string | null; cli: string | null };
}

/** GET /runs/:id: progress, one primary-key read. */
export interface PracticeRun {
  id: string;
  lifecycle: PracticeLifecycle;
  verdict: PracticeVerdict | null;
  endReason: string | null;
  sourceFleetId: string;
  agentId: string;
  sample: boolean;
  runs: number;
  scope: string[] | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  codeExpiresAt: string | null;
  codeTriesLeft: number | null;
  /** Only the WhiteRoom server running the test knows these. */
  progress: { done: number; total: number; lastContactAt: string } | null;
}

/** GET /runs?fleet=: a Past tests row. */
export interface PracticeRunRow {
  id: string;
  lifecycle: PracticeLifecycle;
  verdict: PracticeVerdict | null;
  endReason: string | null;
  sourceFleetId: string;
  agentId: string;
  sample: boolean;
  runs: number;
  scope: string[] | null;
  rerun: boolean;
  createdAt: string;
  endedAt: string | null;
  checks: { passed: number; total: number } | null;
  /** Tasks finished of those planned; the control checks count as one task a run. Older engines leave it out. */
  tasks?: { finished: number; total: number } | null;
}

/** Where the source agent's calls go, so setup can refuse a fleet practice tests can't run yet before Start. */
export type PracticeSourceProvider = 'direct-anthropic' | 'direct-openai' | 'proxy-url' | 'cloud' | 'unknown';

/** GET /source-model: the model the agent asked for most recently, and where its calls go. */
export interface PracticeSource {
  model: string | null;
  provider: PracticeSourceProvider;
}

/** GET /runs/:id/report: the run's result. `report` is null for a test that was ended, or after 30 days. */
export interface PracticeResult {
  id: string;
  lifecycle: PracticeLifecycle;
  verdict: PracticeVerdict | null;
  report: PracticeReport | null;
  detailsKeptUntil: string | null;
  summaryKeptUntil: string | null;
}

/** What Start sends (the BFF adds startedBy). */
export interface PracticeStart {
  fleet: string;
  sample: boolean;
  runs: 1 | 3;
  agent?: string;
  model?: string;
  scope?: string[];
}

export interface RunCode {
  code: string;
  codeExpiresAt: string;
}
