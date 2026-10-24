/**
 * Agent Diagnosis copy (spec Rev 4.4 §6.5). Written from the user's side, in
 * sentence case. Every number printed comes from a finding's `measures`, so a
 * sentence can never claim something the data doesn't hold. "Shift" (the
 * redesign's word for a watch, README › Labels) is defined once, in What we
 * checked.
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

/** Days a Diagnosis snooze lasts. Sent with every snooze, so the copy and the engine agree. */
export const SNOOZE_DAYS = 7;

export const WATCH_DEFINITION = 'A shift is one stretch of work. When an agent’s workspace fills up, it hands over to a fresh shift.';

const num = (v: unknown): string => (typeof v === 'number' ? v.toLocaleString('en-US') : String(v ?? '—'));
const has = (m: DiagnosisMeasures, k: string) => m[k] !== undefined && m[k] !== null && m[k] !== '';

/** A part of a sentence: plain text, or a value from measures (shown in mono). */
export type SentencePart = { text: string } | { value: string; code?: boolean };
const t = (text: string): SentencePart => ({ text });
const v = (x: unknown): SentencePart => ({ value: num(x) });
const code = (x: unknown): SentencePart => ({ value: String(x ?? ''), code: true });

/** "1 shift" / "3 shifts": the number as a value, the noun agreeing with it. */
const count = (x: unknown, one: string, many: string): SentencePart[] => [v(x), t(` ${Number(x) === 1 ? one : many}`)];

/** The finding sentence, as parts so the row can style values. */
export function findingSentence(detector: DiagnosisDetectorId, m: DiagnosisMeasures): SentencePart[] {
  switch (detector) {
    case 'review_handover_churn': {
      // Two engine rules feed this finding: short shifts, or shifts that redid
      // earlier work. Older findings carry no repeat measures.
      const repeatLed = Number(m.longestRepeatStreak) >= 2 && !(Number(m.longestStreak) >= 3);
      const parts = repeatLed
        ? [
            t('Redid '), v(m.repeatedSharePct), t('% of the work it had already done, '),
            ...count(m.longestRepeatStreak, 'shift', 'shifts'), t(' in a row. It likely lost track of what it had found when it handed over, so it did the work again. To fix: have its tools send back shorter answers, or have it save its progress as it goes.'),
          ]
        : [
            t('Handed over after '), ...count(m.medianCallsPerWatch, 'call', 'calls'), t(' on average, '),
            ...count(m.longestStreak, 'shift', 'shifts'), t(' in a row. Its tools likely send back too much at once, which fills its workspace fast. To fix: have its tools send back shorter answers.'),
          ];
      if (Number(m.limitMultiplier) > 1) parts.push(t(' WhiteRoom has raised this agent’s limit '), v(m.limitMultiplier), t('× to keep it working.'));
      return parts;
    }
    case 'review_tool_loops':
      return [
        code(m.toolName), t(' ran with the same request '), ...count(m.maxRepeats, 'time', 'times'), t(' in shift '), v(m.worstWatch), t(', and this happened in '),
        ...count(m.watchesAffected, 'shift', 'shifts'), t(' this week. The agent may be stuck going round in circles.'),
      ];
    case 'review_spend_outliers': {
      const one = Number(m.flaggedDays) === 1;
      return [
        t('Used '), v(m.maxDayTokens), t(' tokens on '), v(m.maxDay), t(', '), v(m.maxDayRatio), t('× as much as a normal busy day. '),
        ...count(m.flaggedDays, 'day', 'days'), t(` this week ${one ? 'was' : 'were'} over 1.5× normal.`),
      ];
    }
    case 'review_tool_errors':
      return [
        code(m.toolName), t(' failed '), ...count(m.toolErrors, 'time', 'times'), t(' this week. '), v(m.errorRatePct), t('% of all its tool steps returned an error ('),
        v(m.totalErrors), t(' of '), v(m.totalResults), t('). To fix: give the tool more time and one retry, or have the agent skip items that keep failing.'),
      ];
    case 'review_tool_silence': {
      const parts = [
        code(m.toolName), t(' has barely been used since '), v(m.lastCalled), t(': '), v(m.recentCallsPerDay), t(' a day this week, down from '),
        v(m.baselineCallsPerDay), t('. The agent is still busy ('), ...count(m.recentCalls, 'call', 'calls'), t('), so it may be stuck and not finishing its work.'),
      ];
      if (Number(m.silentTools) > 1) parts.push(t(' '), v(m.silentTools), t(' tools went quiet at the same time.'));
      return parts;
    }
    case 'review_provider_failures': {
      const parts = has(m, 'failureRatePct')
        ? [v(m.failureRatePct), t('% of requests to '), code(m.model ?? m.provider ?? 'the model'), t(' failed in the last 24 hours ('), v(m.upstreamErrors), t(' of '), v(m.totalRequests), t('). This usually comes from the AI provider, not your agent.')]
        : [t('Requests to the AI provider are failing. This usually comes from the provider, not your agent.')];
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

/** "Needs more data" reasons as short clauses, for Agent health › Health check: what's still missing. Falls back to the engine's text. */
export function notMeasuredShort(code: string, reason: string): string {
  const engineText = () => reason.charAt(0).toLowerCase() + reason.slice(1).replace(/\.$/, '');
  // A count read from the engine's reason; if its wording changed and the
  // number can't be found, the engine's own text is shown rather than a made-up 0.
  const n = (re: RegExp, build: (x: string) => string) => {
    const x = reason.match(re)?.[1];
    return x === undefined ? engineText() : build(x);
  };
  // What's still missing, plainly: the engine's "Needs N" when it says, else
  // the usual target. Nothing left to count (has >= needs): the engine's text.
  const left = (re: RegExp, target: number, build: (more: number) => string) => n(re, (x) => {
    const more = Number(reason.match(/needs (\d+)/i)?.[1] ?? target) - Number(x);
    return more > 0 ? build(more) : engineText();
  });
  switch (code) {
    case 'few_watches': return left(/has (\d+)/, 5, (m) => `needs ${m} more ${m === 1 ? 'shift' : 'shifts'}`);
    case 'short_history': return left(/has (\d+)/, 14, (m) => `starts in about ${m} ${m === 1 ? 'day' : 'days'}`);
    case 'low_coverage': return n(/for (\d+)%/, (x) => `can only see ${x}% of its tool calls`);
    case 'hashing_off':
    case 'detector_off': return 'switched off on this engine';
    case 'openai_format': return 'only works with Anthropic-format tools';
    case 'few_results': return left(/has (\d+)/, 20, (m) => `needs ${m} more tool ${m === 1 ? 'result' : 'results'}`);
    case 'not_captured': return 'nothing recorded yet';
    case 'few_measured_calls': return left(/has (\d+)/, 50, (m) => `needs ${m} more fully recorded ${m === 1 ? 'call' : 'calls'} this week`);
    case 'few_requests': return left(/had (\d+)/, 100, (m) => `needs ${m} more ${m === 1 ? 'call' : 'calls'} to one model in a day`);
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
        'Have the agent’s tools send back short answers, not everything at once: a few results at a time, plain text instead of whole web pages, a summary instead of a full document.',
        'Or have the agent write down its progress after each step, so the next shift can pick up where the last one stopped.',
        'Open the calls to see what was done twice.',
      ];
    case 'tool_errors':
      return [
        `Open the calls to see when ${tool} failed. Your agent’s logs will show why.`,
        'Common fixes: give the tool more time and let it try once more, or skip items that keep failing.',
      ];
    case 'tool_silence':
      return [
        `Open the calls to see what the agent does instead of using ${tool}.`,
        'Common causes: an earlier step fails so the agent never gets there, its instructions changed, or it thinks the work is already done.',
      ];
    case 'provider_failures':
      return ['Open the calls to see which errors came back. Usually the fix is to wait and try again, or switch to another model until the provider recovers.'];
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
export const ALREADY_CHANGED_NOTICE = 'This suggestion had already changed, so nothing was applied. The list now shows where it stands.';
