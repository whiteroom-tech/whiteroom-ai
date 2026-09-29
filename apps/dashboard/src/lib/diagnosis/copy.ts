/**
 * Agent Diagnosis copy (spec Rev 4.4 §6.5). Written from the user's side, in
 * sentence case. Every number printed comes from a finding's `measures`, so a
 * sentence can never claim something the data doesn't hold. "Watch" stays
 * (Citadel glossary) and is defined once, in What we checked.
 */
import type { DiagnosisDetectorId, DiagnosisMeasures } from '@/lib/whiteroom/types';

export const DIAGNOSIS_DETECTORS: DiagnosisDetectorId[] = [
  'review_handover_churn',
  'review_tool_loops',
  'review_spend_outliers',
  'review_tool_errors',
  'review_tool_silence',
  'review_provider_failures',
];

export function isDiagnosisDetector(detector: string): detector is DiagnosisDetectorId {
  return (DIAGNOSIS_DETECTORS as string[]).includes(detector);
}

export const TITLES: Record<DiagnosisDetectorId, string> = {
  review_handover_churn: 'Handing over too often',
  review_tool_loops: 'Repeating the same call',
  review_spend_outliers: 'Unusually expensive days',
  review_tool_errors: 'A tool keeps failing',
  review_tool_silence: 'Stopped using a key tool',
  review_provider_failures: 'Model provider errors',
};

/** Lower-case form for "Looks fine: …" lists. */
export const titleLower = (d: string) => {
  const t = TITLES[d as DiagnosisDetectorId] ?? d.replace(/^review_/, '').replace(/_/g, ' ');
  return t.charAt(0).toLowerCase() + t.slice(1);
};

/** Days a Diagnosis snooze lasts. Sent with every snooze, so the copy and the engine agree. */
export const SNOOZE_DAYS = 7;

export const WATCH_DEFINITION = 'A watch is one stretch of work before an agent hands over to a fresh context.';

const num = (v: unknown): string => (typeof v === 'number' ? v.toLocaleString('en-US') : String(v ?? '—'));
const has = (m: DiagnosisMeasures, k: string) => m[k] !== undefined && m[k] !== null && m[k] !== '';

/** A part of a sentence: plain text, or a value from measures (shown in mono). */
export type SentencePart = { text: string } | { value: string; code?: boolean };
const t = (text: string): SentencePart => ({ text });
const v = (x: unknown): SentencePart => ({ value: num(x) });
const code = (x: unknown): SentencePart => ({ value: String(x ?? ''), code: true });

/** "1 watch" / "3 watches": the number as a value, the noun agreeing with it. */
const count = (x: unknown, one: string, many: string): SentencePart[] => [v(x), t(` ${Number(x) === 1 ? one : many}`)];

/** The finding sentence, as parts so the row can style values. */
export function findingSentence(detector: DiagnosisDetectorId, m: DiagnosisMeasures): SentencePart[] {
  switch (detector) {
    case 'review_handover_churn': {
      const parts = [
        t('Handed over after '), ...count(m.medianCallsPerWatch, 'call', 'calls'), t(' on average, '),
        ...count(m.longestStreak, 'watch', 'watches'), t(' in a row. This often means tool results are too large for one watch. If so, return smaller results (page them, drop raw HTML, summarise first).'),
      ];
      if (Number(m.limitMultiplier) > 1) parts.push(t(' WhiteRoom has raised this agent’s limit '), v(m.limitMultiplier), t('× to keep it working.'));
      return parts;
    }
    case 'review_tool_loops':
      return [
        code(m.toolName), t(' repeated '), ...count(m.maxRepeats, 'time', 'times'), t(' in watch '), v(m.worstWatch), t(', and in '),
        ...count(m.watchesAffected, 'watch', 'watches'), t(' this week.'),
      ];
    case 'review_spend_outliers': {
      const one = Number(m.flaggedDays) === 1;
      return [
        t('Used '), v(m.maxDayTokens), t(' tokens on '), v(m.maxDay), t(', '), v(m.maxDayRatio), t('× its usual busy day. '),
        ...count(m.flaggedDays, 'day', 'days'), t(` this week ${one ? 'was' : 'were'} over 1.5×.`),
      ];
    }
    case 'review_tool_errors':
      return [
        code(m.toolName), t(' failed '), ...count(m.toolErrors, 'time', 'times'), t(' this week. '), v(m.errorRatePct), t('% of all tool results were errors ('),
        v(m.totalErrors), t(' of '), v(m.totalResults), t('). Check that tool’s timeouts and inputs, or skip targets that keep failing.'),
      ];
    case 'review_tool_silence': {
      const parts = [
        code(m.toolName), t(' has barely been called since '), v(m.lastCalled), t(': '), v(m.recentCallsPerDay), t(' a day this week, down from '),
        v(m.baselineCallsPerDay), t('. The agent is still busy ('), ...count(m.recentCalls, 'call', 'calls'), t('), so it may be working without finishing its task.'),
      ];
      if (Number(m.silentTools) > 1) parts.push(t(' '), v(m.silentTools), t(' tools went quiet at the same time.'));
      return parts;
    }
    case 'review_provider_failures': {
      const parts = has(m, 'failureRatePct')
        ? [v(m.failureRatePct), t('% of calls to '), code(m.model ?? m.provider ?? 'the model'), t(' failed in the last 24 hours ('), v(m.upstreamErrors), t(' of '), v(m.totalRequests), t(').')]
        : [t('Calls to the model provider are failing.')];
      if (Number(m.otherCohorts) > 0) {
        const one = Number(m.otherCohorts) === 1;
        parts.push(t(' '), ...count(m.otherCohorts, 'other model', 'other models'), t(` ${one ? 'is' : 'are'} also failing.`));
      }
      return parts;
    }
  }
}

export const sentenceText = (parts: SentencePart[]) => parts.map((p) => ('text' in p ? p.text : p.value)).join('');

/** "About 1,200,000 tokens (≈ $1.84) went to this in the last 7 days." — or null. */
export function costLine(estWastedTokens: number | null | undefined, estWastedCostMicros: number | null | undefined): string | null {
  if (estWastedTokens == null) return null;
  const cost = estWastedCostMicros != null ? ` (≈ $${(estWastedCostMicros / 1_000_000).toFixed(2)})` : '';
  return `About ${estWastedTokens.toLocaleString('en-US')} tokens${cost} went to this in the last 7 days.`;
}

/** Engine limitations, reworded where the engine's text is technical. */
export function limitationText(detector: DiagnosisDetectorId, limitation: string | null | undefined): string | null {
  if (!limitation) return null;
  if (detector === 'review_tool_errors') return 'Only counts errors your agent reports back.';
  if (detector === 'review_tool_silence') return 'Only counts calls WhiteRoom sees in full. If you stopped using this tool on purpose, dismiss this.';
  if (detector === 'review_handover_churn') return null; // internal nuance; the sentence already hedges
  return limitation;
}

/** "Needs more data" reasons as short clauses, for What we checked. Falls back to the engine's text. */
export function notMeasuredShort(code: string, reason: string): string {
  const engineText = () => reason.charAt(0).toLowerCase() + reason.slice(1).replace(/\.$/, '');
  // A count read from the engine's reason; if its wording changed and the
  // number can't be found, the engine's own text is shown rather than a made-up 0.
  const n = (re: RegExp, build: (x: string) => string) => {
    const x = reason.match(re)?.[1];
    return x === undefined ? engineText() : build(x);
  };
  switch (code) {
    case 'few_watches': return n(/has (\d+)/, (x) => `${x} of 5 watches so far`);
    case 'short_history': return n(/has (\d+)/, (x) => `${x} of 14 days of history so far`);
    case 'low_coverage': return n(/for (\d+)%/, (x) => `can only see ${x}% of its tool calls`);
    case 'hashing_off':
    case 'detector_off': return 'switched off on this engine';
    case 'openai_format': return 'only works with Anthropic-format tools';
    case 'few_results': return n(/has (\d+)/, (x) => `${x} of 20 tool results so far`);
    case 'not_captured': return 'nothing recorded yet';
    case 'few_measured_calls': return n(/has (\d+)/, (x) => `${x} of 50 fully recorded calls this week`);
    case 'few_requests': return n(/had (\d+)/, (x) => `busiest model had ${x} of the 100 calls needed in 24 hours`);
    case 'thin_evidence': return 'too few calls show it yet';
    case 'first_check_pending': return 'first check runs overnight';
    case 'publish_failed': return 'couldn\u2019t be saved; checked again soon';
    default: return engineText();
  }
}

/** How-to text (§6.5); only claims the evidence can show. */
export function howtoParagraphs(howtoId: string, m: DiagnosisMeasures): string[] {
  const tool = String(m.toolName ?? 'that tool');
  switch (howtoId) {
    case 'handover_churn':
      return [
        'Return smaller tool results so one watch can hold several steps: page long lists, drop raw HTML, and summarise before returning.',
        'Open the calls to see how many calls each watch held before it handed over.',
      ];
    case 'tool_errors':
      return [
        `See which calls reported a ${tool} error. Check your agent’s logs for the cause.`,
        'Common fixes: add a timeout and one retry, or skip targets that keep failing.',
      ];
    case 'tool_silence':
      return [
        `Open the calls and check what the agent does instead of calling ${tool}.`,
        'Common causes: an earlier step fails so the agent never reaches it, the task prompt changed, or the agent decides the work is already done.',
      ];
    case 'provider_failures':
      return ['Open the calls to see which status codes came back. Retry with backoff, or route to another model while the provider recovers.'];
    default:
      return [];
  }
}

export const RULE_LABEL: Record<'loop_breaker' | 'spend_cap', string> = { loop_breaker: 'loop breaker', spend_cap: 'spend cap' };
export const RULE_TITLE: Record<'loop_breaker' | 'spend_cap', string> = { loop_breaker: 'Loop breaker', spend_cap: 'Spend cap' };

export const STATUS_LABEL: Record<string, string> = {
  open: 'open',
  snoozed: `snoozed ${SNOOZE_DAYS} days`,
  dismissed: 'dismissed',
  reported_implemented: 'marked fixed',
  resolved: 'stopped happening',
};

export const MARKED_FIXED_TOAST = 'Marked as fixed. You can find it under Implemented.';
