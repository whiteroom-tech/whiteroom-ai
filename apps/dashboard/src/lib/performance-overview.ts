// Performance overview wording (mockup parity): the lead line, the "vs prior"
// trends, the tokens with/without totals, the Control section's figures and
// Agent health's checks grouped by check. Pure, so the wording is tested
// without rendering.
import type { FleetDiagnosis, GovernanceRule, GovernanceRuleType, PerformanceModelSummary, RuleActionCounts } from '@/lib/whiteroom/types';
import type { DaySavings } from '@/lib/analytics-metrics';
import type { GovernanceCounts, GovernanceTally } from '@/lib/governance';
import { RULE_LABELS } from '@/lib/governance';
import { DIAGNOSIS_DETECTORS, notMeasuredShort } from '@/lib/diagnosis/copy';
import { checkTitle } from '@/lib/diagnosis/model';
import { alertOnly, ruleSentence } from '@/lib/controls-view';
import { fmtCost, fmtCount, fmtEnergy, fmtTokens, plural } from '@/lib/format';

/** A lookback in words: "last 14 days", "last day", "last 6 hours"; null when unknown. */
export function lookbackText(hours: number | null | undefined): string | null {
  if (!hours || !(hours > 0)) return null;
  if (hours < 24) { const h = Math.round(hours); return `last ${h} ${plural(h, 'hour')}`; }
  const d = Math.round(hours / 24);
  return d === 1 ? 'last day' : `last ${d} days`;
}

/**
 * The prior period's name, for the trend lines: "last 7 days" → "prior 7 days".
 * Other ranges ("today", "Oct 1 – Oct 20") are named by the window's length
 * (`period`, the engine's): "prior 15 h", "prior 20 days".
 */
export function priorLabel(rangeLabel: string, period?: { start: string; end: string }): string {
  if (rangeLabel.startsWith('last ') || !period) return rangeLabel.replace(/^last /, 'prior ');
  const ms = Date.parse(period.end) - Date.parse(period.start);
  if (!(ms > 0)) return 'prior period';
  const days = Math.round(ms / 86_400_000);
  // Whole days, give or take a DST hour.
  if (days >= 1 && Math.abs(ms - days * 86_400_000) <= 3_600_000) return `prior ${days} ${plural(days, 'day')}`;
  return `prior ${Math.max(1, Math.round(ms / 3_600_000))} h`;
}

/** Whole-percent change from `before` to `now`; null when there's nothing to compare with. */
export function pctChange(now: number, before: number | null | undefined): number | null {
  if (before == null || !(before > 0) || !Number.isFinite(now)) return null;
  return Math.round(((now - before) / before) * 100);
}

/** A trend line: "↑ 190% vs prior 7 days", "no change vs …"; null without a prior figure. */
export function trendText(change: number | null, prior: string): string | null {
  if (change === null) return null;
  if (change === 0) return `no change vs ${prior}`;
  return `${change > 0 ? '↑' : '↓'} ${fmtCount(Math.abs(change))}% vs ${prior}`;
}

/** Typical response's trend: faster is good (green), slower is a warning. */
export function latencyTrend(nowMs: number | null, beforeMs: number | null | undefined, prior: string): { text: string; tone: 'ok' | 'warn' | 'tx2' } | null {
  if (nowMs == null) return null;
  const change = pctChange(nowMs, beforeMs);
  if (change === null) return null;
  if (change === 0) return { text: `no change vs ${prior}`, tone: 'tx2' };
  return change < 0
    ? { text: `↓ ${Math.abs(change)}% faster vs ${prior}`, tone: 'ok' }
    : { text: `↑ ${change}% slower vs ${prior}`, tone: 'warn' };
}

/** Spend per call against the prior window, for Spend by model's closed row: "spend per call ↓21% vs prior 7 days". */
export function perCallTrend(now: { calls: number; cost: number }, before: { totalCalls: number; totalCost: number } | undefined, prior: string): string | null {
  if (!before || now.calls <= 0 || before.totalCalls <= 0 || before.totalCost <= 0) return null;
  const change = pctChange(now.cost / now.calls, before.totalCost / before.totalCalls);
  if (change === null) return null;
  return change === 0 ? `spend per call unchanged vs ${prior}` : `spend per call ${change > 0 ? '↑' : '↓'}${Math.abs(change)}% vs ${prior}`;
}

/** "3.18M fewer tokens · about 65% less", or null when nothing was saved. */
export function fewerTokens(saved: number, used: number): string | null {
  if (!(saved > 0)) return null;
  const pct = Math.round((saved / (used + saved)) * 100);
  return `${fmtTokens(saved)} fewer tokens · about ${pct}% less`;
}

/** Saved by WhiteRoom's caption: what the dollars stand for. */
export function savedCaption(tokensSaved: number, cacheMicros: number): string {
  // The tokens are Smaller context's card, beside this one: here, what the dollars are.
  if (tokensSaved > 0) return `estimated, at your model prices${cacheMicros > 0 ? ' · includes cache reads' : ''}`;
  return cacheMicros > 0 ? 'from cache reads · estimated' : 'nothing saved in this range';
}

/**
 * Smaller context's card, for the range shown (as every Cost figure is): how much less went to
 * the models, the tokens and the energy. The same tokens as "Tokens: with WhiteRoom vs without".
 * `used` null: not known yet.
 */
export function rangeContextCard(saved: number, used: number | null): { value: string; sub: string } {
  if (used === null) return { value: '—', sub: 'not available yet' };
  if (!(saved > 0)) return { value: '—', sub: 'nothing saved in this range' };
  const pct = Math.round((saved / (used + saved)) * 100);
  const energy = fmtEnergy(saved);
  return { value: `${pct}%`, sub: `less sent to models · ${fmtTokens(saved)} fewer tokens${energy ? ` · ${energy} saved` : ''}` };
}

/** Totals over the chart's days: tokens with WhiteRoom and the estimate without it. */
export function tokenTotals(days: DaySavings[]): { used: number; without: number; saved: number } {
  const used = days.reduce((n, d) => n + d.used, 0);
  const saved = days.reduce((n, d) => n + d.saved, 0);
  return { used, without: used + saved, saved };
}

/** "Prices from Oct 19" from the catalogue's version date; a version that isn't a date is named as is. */
export function pricesFrom(version: string): string {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(version) ? new Date(`${version}T12:00:00`) : null;
  return d && !Number.isNaN(d.getTime()) ? `Prices from ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}.` : `Prices: ${version}.`;
}

/** Each model's share of spend, biggest first, for the stacked bar. */
export function modelShares(models: PerformanceModelSummary[]): Array<{ model: PerformanceModelSummary; share: number }> {
  const total = models.reduce((n, m) => n + m.costMicros, 0);
  if (total <= 0) return [];
  return [...models].sort((a, b) => b.costMicros - a.costMicros).map((model) => ({ model, share: model.costMicros / total }));
}

// -- Lead line ----------------------------------------------------------------

/** "rules caught 120 times, none blocked" / "rules caught 3 times, 1 blocked" / "rules caught nothing". Times, not calls: two rules on one call count twice. */
export function rulesCaughtText(total: number, blocked: number): string {
  if (total <= 0) return 'rules caught nothing';
  return `rules caught ${fmtCount(total)} ${plural(total, 'time')}, ${blocked > 0 ? `${fmtCount(blocked)} blocked` : 'none blocked'}`;
}

// -- Control ------------------------------------------------------------------

/** "8 rules: 1 Block · 7 Record only · 0 Off" (and "· 1 Alert only" when a rule only alerts: it never blocks). */
export function ruleModeCounts(rules: GovernanceRule[]): string {
  const n = (m: GovernanceRule['mode']) => rules.filter((r) => r.mode === m).length;
  const alert = rules.filter(alertOnly).length;
  return `${fmtCount(rules.length)} ${plural(rules.length, 'rule')}: ${n('enforce') - alert} Block${alert ? ` · ${alert} Alert only` : ''} · ${n('watch')} Record only · ${n('off')} Off`;
}

export interface CaughtRow {
  /** "Model allowlist", "Spend caps (3 rules)", "Keywords (rule since removed)". */
  label: string;
  blocked: number;
  wouldBlock: number;
  /** The rule's mode tag; null when rows of several modes are grouped, or the rule is gone. */
  mode: GovernanceRule['mode'] | null;
  /** The rule to open in Controls; null for a removed rule or a group. */
  ruleId: string | null;
}

const caught = (c: { blocked: number; wouldAct: number }) => c.blocked + c.wouldAct;

/**
 * The three rules that caught the most. Per rule id when the engine sends it;
 * else per rule type, with the rules of that type counted ("Spend caps (3 rules)").
 */
export function topCaught(counts: GovernanceCounts | null, byRuleId: Record<string, RuleActionCounts> | undefined, rules: GovernanceRule[] | null, limit = 3): CaughtRow[] {
  if (byRuleId) {
    const byId = new Map((rules ?? []).map((r) => [r.id, r]));
    return Object.entries(byRuleId)
      .filter(([, c]) => caught(c) > 0)
      .sort(([a, x], [b, y]) => caught(y) - caught(x) || a.localeCompare(b))
      .slice(0, limit)
      .map(([id, c]) => {
        const rule = byId.get(id);
        const type = (rule?.ruleType ?? id.split(':')[0]) as GovernanceRuleType;
        const name = RULE_LABELS[type];
        // Several rules of one type: the label alone wouldn't say which.
        const same = (rules ?? []).filter((r) => r.ruleType === type).length;
        return {
          label: !rule ? (name ? `${name} (rule since removed)` : 'A rule since removed') : same > 1 ? `${name} · ${ruleSentence(rule).val}` : name,
          blocked: c.blocked, wouldBlock: c.wouldAct, mode: rule?.mode ?? null, ruleId: rule ? id : null,
        };
      });
  }
  if (!counts) return [];
  return (Object.entries(counts.byRule) as [GovernanceRuleType, GovernanceTally][])
    .filter(([, t]) => t.blocks + t.wouldBlocks > 0)
    .sort(([a, x], [b, y]) => y.blocks + y.wouldBlocks - (x.blocks + x.wouldBlocks) || a.localeCompare(b))
    .slice(0, limit)
    .map(([type, t]) => {
      const ofType = (rules ?? []).filter((r) => r.ruleType === type);
      const modes = new Set(ofType.map((r) => r.mode));
      const label = ofType.length > 1 ? `${RULE_LABELS[type]}s (${ofType.length} rules)` : RULE_LABELS[type];
      return { label, blocked: t.blocks, wouldBlock: t.wouldBlocks, mode: modes.size === 1 ? ofType[0].mode : null, ruleId: ofType.length === 1 ? ofType[0].id : null };
    });
}

/** All rules and agents, rule-type table: types with activity, then the quiet ones on one muted row. */
export function ruleTypeRows(counts: GovernanceCounts): { active: Array<{ label: string; blocked: number; wouldBlock: number }>; quiet: string[] } {
  const all = Object.entries(counts.byRule) as [GovernanceRuleType, GovernanceTally][];
  const active = all.filter(([, t]) => t.blocks + t.wouldBlocks > 0)
    .sort(([, x], [, y]) => y.blocks + y.wouldBlocks - (x.blocks + x.wouldBlocks))
    .map(([type, t]) => ({ label: RULE_LABELS[type], blocked: t.blocks, wouldBlock: t.wouldBlocks }));
  return { active, quiet: all.filter(([, t]) => t.blocks + t.wouldBlocks === 0).map(([type]) => RULE_LABELS[type]) };
}

/** All rules and agents, agent table: agents a rule caught, most first; '' (no agent) reads "Unnamed agent". */
export function ruleAgentRows(counts: GovernanceCounts): Array<{ agent: string; blocked: number; wouldBlock: number }> {
  return Object.entries(counts.byAgent)
    .filter(([, t]) => t.blocks + t.wouldBlocks > 0)
    .sort(([a, x], [b, y]) => y.blocks + y.wouldBlocks - (x.blocks + x.wouldBlocks) || a.localeCompare(b))
    .map(([agent, t]) => ({ agent, blocked: t.blocks, wouldBlock: t.wouldBlocks }));
}

// -- Agent health ---------------------------------------------------------------

export interface CheckGroup {
  title: string;
  /** "7 passed", "3 passed · 4 set aside", "needs about 14 more days · 7 agents". */
  status: string;
  /** ok (green) only when every agent checked passed; neutral when some are waiting or set aside. */
  tone: 'problem' | 'ok' | 'neutral';
  /** Agents with an open finding for this check. */
  problemAgents: string[];
}

/**
 * Health checks grouped by check, one row each (six today), across agents:
 * problems, then passed, set aside, and what the rest still need.
 */
export function checkGroups(d: FleetDiagnosis): CheckGroup[] {
  const order = [...DIAGNOSIS_DETECTORS as string[]];
  const groups = new Map<string, { problems: string[]; passed: number; setAside: number; waiting: Map<string, number> }>();
  const group = (detector: string) => {
    if (!order.includes(detector)) order.push(detector);
    let g = groups.get(detector);
    if (!g) groups.set(detector, g = { problems: [], passed: 0, setAside: 0, waiting: new Map() });
    return g;
  };
  for (const r of d.reports) {
    for (const f of r.findings) { const g = group(f.detector); if (f.status === 'open') g.problems.push(r.agentId); else g.setAside++; }
    for (const c of r.clear) group(c.detector).passed++;
    for (const n of r.notMeasured) { const g = group(n.detector); const note = notMeasuredShort(n.code, n.reason); g.waiting.set(note, (g.waiting.get(note) ?? 0) + 1); }
  }
  return order.filter((det) => groups.has(det)).map((det) => {
    const g = groups.get(det)!;
    const parts = [
      g.problems.length ? `${g.problems.length} ${plural(g.problems.length, 'problem')}` : '',
      g.passed ? `${g.passed} passed` : '',
      g.setAside ? `${g.setAside} set aside` : '',
      ...[...g.waiting].map(([note, n]) => `${note} · ${n} ${plural(n, 'agent')}`),
    ].filter(Boolean);
    return { title: checkTitle(det), status: parts.join(' · '), tone: g.problems.length ? 'problem' : g.passed && !g.waiting.size && !g.setAside ? 'ok' : 'neutral', problemAgents: g.problems };
  });
}

/** Agent health's headline: "No issues in 17 checks" / "2 problems in 19 checks", and what's still waiting. */
export function healthHeadline(s: { fine: number; needsData: number; openFindings: number }): { title: string; sub: string | null; tone: 'ok' | 'warn' } {
  const ran = s.fine + s.openFindings;
  const title = s.openFindings > 0
    ? `${s.openFindings} ${plural(s.openFindings, 'problem')} in ${ran} ${plural(ran, 'check')}`
    : ran > 0 ? `No issues in ${ran} ${plural(ran, 'check')}` : 'No checks could run yet';
  const sub = s.needsData > 0 ? `${s.needsData} more ${plural(s.needsData, 'check needs', 'checks need')} more data before ${s.needsData === 1 ? 'it' : 'they'} can run` : null;
  return { title, sub, tone: s.openFindings > 0 ? 'warn' : 'ok' };
}

/** Health checks' closed row: "17 passed · 22 need more data". */
export function healthCounts(s: { fine: number; needsData: number; openFindings: number }): string {
  return [
    s.openFindings ? `${s.openFindings} ${plural(s.openFindings, 'problem')}` : '',
    s.fine ? `${s.fine} passed` : '',
    s.needsData ? `${s.needsData} need${s.needsData === 1 ? 's' : ''} more data` : '',
  ].filter(Boolean).join(' · ');
}

/** Hourly cost: the fleet's spend per working hour (engine performance_cost_forecast). */
export interface WorkingHourRate {
  usdPerHour: number;
  lookbackHours: number | null;
  /** Recent calls had no price on file: the rate is unknown, not $0. */
  unpriced?: boolean;
}

/**
 * Cost prediction's folded note: the whole fleet's hourly cost, then `rest` (the budgets note).
 * "$0.354 an hour while agents work, last 14 days · 1 agent with a budget". Hourly cost is per
 * agent inside the card, so the fleet figure is only this note. `null`: it couldn't be read;
 * `undefined`: not passed (the note is just `rest`).
 */
export function predictionNote(fleetHourly: WorkingHourRate | null | undefined, rest: string | undefined): string | undefined {
  let hourly = '';
  if (fleetHourly === null) hourly = 'hourly cost couldn’t load';
  else if (fleetHourly?.unpriced) hourly = 'hourly cost: recent calls have no price on file yet';
  else if (fleetHourly && fleetHourly.usdPerHour > 0) {
    const since = lookbackText(fleetHourly.lookbackHours);
    hourly = `${fmtCost(Math.round(fleetHourly.usdPerHour * 1_000_000))} an hour while agents work${since ? `, ${since}` : ''}`;
  }
  return [hourly, rest].filter(Boolean).join(' · ') || undefined;
}
