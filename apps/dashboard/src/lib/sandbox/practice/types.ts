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
  tested: {
    fleet: string; agent: string; modelRequested: string | null; modelsUsed: string[]; adapter: string | null; cli: string | null;
    /** R7: the provider of the Fleet key key the test used; null for the fleet's own key. Older engines leave it out. */
    provider?: string | null;
  };
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

/** Why a practice test can't use a key or fleet (R7): the engine's catalog `keyRefusals`. */
export type PracticeKeyRefusal = 'engine_access_key' | 'other_host' | 'unsupported_provider' | 'short_term_key' | 'bedrock_role' | 'key_not_found' | 'model_required';

/** A Fleet key provider key, as setup's picker shows it (R7). No secrets: the display prefix is what Fleet key lists. */
export interface PracticeProviderKey {
  displayPrefix: string;
  provider: string;
  endpointHost: string | null;
  region: string | null;
  keyHint: string;
  createdAt: string;
  eligible: boolean;
  reason: PracticeKeyRefusal | null;
}

/** GET /source-model: the model the agent asked for most recently, where its calls go, and (R7) the keys setup can pick from. */
export interface PracticeSource {
  model: string | null;
  provider: PracticeSourceProvider;
  /** The fleet's own key can start a test (bound, with no host of its own). */
  directKey: boolean;
  /** The whole fleet can't be tested: it reaches Bedrock through an IAM role. */
  blocked: 'bedrock_role' | null;
  providerKeys: PracticeProviderKey[];
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
  /** R7: the Fleet key provider key to test with ("sk-wr-" and 16 hex, as Fleet key lists it). */
  proxyKeyDisplayPrefix?: string;
}

export interface RunCode {
  code: string;
  codeExpiresAt: string;
}
