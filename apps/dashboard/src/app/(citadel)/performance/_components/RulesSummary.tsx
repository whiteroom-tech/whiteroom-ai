'use client';

/**
 * Performance › Rules: what the rules caught, read only. One line (blocked,
 * would have acted), and the three rules that caught the most under it. Each rule and its settings are in Controls; each agent's rule
 * activity is on Home's agents table.
 */
import Link from 'next/link';
import type { GovernanceRule, RuleActionCounts, UnknownGovernanceRule } from '@/lib/whiteroom/types';
import { RULE_LABELS, type GovernanceCounts } from '@/lib/governance';
import type { RouteWatch } from '@/lib/analytics-metrics';
import { topCaught } from '@/lib/performance-overview';
import { fmtCost, fmtCount, plural } from '@/lib/format';
import { ROUTES } from '@/lib/routes';
import { ModeTag } from './primitives';

export function RulesSummary({ counts, byRuleId, rules, unknownRules, unavailable, routeWatch = null }: {
  /** Null while unknown. */
  counts: GovernanceCounts | null;
  /** Per rule id, from the same rows as the totals (newer engines). */
  byRuleId?: Record<string, RuleActionCounts>;
  /** The fleet's rules; null when they couldn't be read. */
  rules: GovernanceRule[] | null;
  /** Rules of a type this build doesn't know: named as such, never counted as another type. */
  unknownRules?: UnknownGovernanceRule[];
  /** The counts couldn't be read: unknown, never zero. */
  unavailable: boolean;
  /** The range's calls that could use a cheaper model (Model routing in Watch); null when the engine sends none. */
  routeWatch?: RouteWatch | null;
}) {
  const top = topCaught(counts, byRuleId, rules, unknownRules);
  const extra = counts ? [
    counts.paused ? `${fmtCount(counts.paused)} paused` : '',
    counts.stopped ? `${fmtCount(counts.stopped)} stopped` : '',
    counts.toldYou ? `${fmtCount(counts.toldYou)} alerted` : '',
    counts.trimmed ? `${fmtCount(counts.trimmed)} trimmed` : '',
  ].filter(Boolean) : [];

  return (
    <div className="wr-pcard" style={{ overflow: 'hidden' }}>
      <p className="wr-rules-line">
        {counts ? (
          <>
            <strong className="wr-strong">{fmtCount(counts.blocks)}</strong> blocked · <strong className="wr-strong">{fmtCount(counts.wouldBlocks)}</strong> would have acted
            {extra.length > 0 && <> · {extra.join(' · ')}</>}
          </>
        ) : <span className="wr-cap">{unavailable ? 'Rule activity couldn’t load, retrying on the next refresh' : 'Loading…'}</span>}
      </p>
      {counts && (
        <div className="wr-rules-top">
          {top.length === 0 ? (
            <p className="wr-cap" style={{ margin: 0, padding: '10px 0' }}>Nothing caught in this range.</p>
          ) : top.map((r, i) => {
            const inner = (
              <>
                <span className="wr-ctrl__name">{r.label}</span>
                <span className="wr-cap">
                  {r.blocked > 0 && <>blocked <strong className="wr-strong">{fmtCount(r.blocked)}</strong>{r.wouldBlock > 0 && ' · '}</>}
                  {r.wouldBlock > 0 && <>would have acted <strong className="wr-strong">{fmtCount(r.wouldBlock)}</strong></>}
                </span>
                {r.mode && <ModeTag mode={r.mode} />}
              </>
            );
            return r.ruleId
              ? <Link key={r.ruleId} href={`${ROUTES.controls}?rule=${encodeURIComponent(r.ruleId)}`} className="wr-ctrl__row">{inner}</Link>
              : <div key={`${r.label}:${i}`} className="wr-ctrl__row">{inner}</div>;
          })}
        </div>
      )}
      {routeWatch && routeWatch.calls > 0 && <RouteWatchRow watch={routeWatch} rules={rules} />}
    </div>
  );
}

/**
 * Model routing in Watch: the calls that could use a cheaper model, and what
 * they cost at each. Its own row, apart from what rules caught: nothing was
 * wrong with these calls, and nothing was changed, so it isn't a saving.
 */
function RouteWatchRow({ watch, rules }: { watch: RouteWatch; rules: GovernanceRule[] | null }) {
  const own = (rules ?? []).filter((r) => r.ruleType === 'model_route');
  const inner = (
    <>
      <span className="wr-ctrl__name">{RULE_LABELS.model_route}</span>
      <span className="wr-cap">
        <strong className="wr-strong">{fmtCount(watch.calls)}</strong> {plural(watch.calls, 'call')} could use a cheaper model
        {watch.calls > watch.unpricedCalls && <> · <strong className="wr-strong">{fmtCost(watch.baselineMicros)}</strong> as sent, <strong className="wr-strong">{fmtCost(watch.costMicros)}</strong> on the cheaper model</>}
        {watch.unpricedCalls > 0 && <> · {fmtCount(watch.unpricedCalls)} not priced</>}
      </span>
      <ModeTag mode="watch" />
    </>
  );
  return (
    <div className="wr-rules-route">
      {/* One rule: the row opens it. Several: there is no single rule to open. */}
      {own.length === 1
        ? <Link href={`${ROUTES.controls}?rule=${encodeURIComponent(own[0].id)}`} className="wr-ctrl__row">{inner}</Link>
        : <div className="wr-ctrl__row">{inner}</div>}
      <p className="wr-cap" style={{ margin: 0, padding: '0 0 10px' }}>The same usage at list prices. Nothing was changed, so this isn’t a saving.</p>
    </div>
  );
}
