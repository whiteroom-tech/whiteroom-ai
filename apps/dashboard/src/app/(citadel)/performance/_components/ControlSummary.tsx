/**
 * Performance › Rules: what the rules caught, read only. One line (blocked,
 * would have acted, the rules by mode), and the rules that caught the most
 * folded below. Each rule and its settings are in Controls; each agent's rule
 * activity is on Home's agents table.
 */
import { useId, useState } from 'react';
import Link from 'next/link';
import type { GovernanceRule, RuleActionCounts } from '@/lib/whiteroom/types';
import type { GovernanceCounts } from '@/lib/governance';
import { ruleModeCounts, topCaught } from '@/lib/performance-overview';
import { fmtCount } from '@/lib/format';
import { ROUTES } from '@/lib/routes';
import { Disclosure, ModeTag } from './primitives';

export function ControlSummary({ counts, byRuleId, rules, unavailable }: {
  /** Null while unknown. */
  counts: GovernanceCounts | null;
  /** Per rule id, from the same rows as the totals (newer engines). */
  byRuleId?: Record<string, RuleActionCounts>;
  /** The fleet's rules; null when they couldn't be read. */
  rules: GovernanceRule[] | null;
  /** The counts couldn't be read: unknown, never zero. */
  unavailable: boolean;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const top = topCaught(counts, byRuleId, rules);
  const extra = counts ? [
    counts.paused ? `${fmtCount(counts.paused)} paused` : '',
    counts.stopped ? `${fmtCount(counts.stopped)} stopped` : '',
    counts.toldYou ? `${fmtCount(counts.toldYou)} alerted` : '',
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
        {rules && <span className="wr-cap"> · {ruleModeCounts(rules)}</span>}
      </p>
      {counts && (
        <Disclosure label="What your rules caught most" note={top.length ? `top ${top.length}` : 'nothing caught in this range'} open={open} onToggle={() => setOpen((v) => !v)} controls={bodyId}>
          <div className="wr-rules-top">
            {top.length === 0 ? (
              <p className="wr-cap" style={{ margin: 0 }}>Nothing caught in this range.</p>
            ) : top.map((r) => {
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
                ? <Link key={r.label} href={`${ROUTES.controls}?rule=${encodeURIComponent(r.ruleId)}`} className="wr-ctrl__row">{inner}</Link>
                : <div key={r.label} className="wr-ctrl__row">{inner}</div>;
            })}
          </div>
        </Disclosure>
      )}
    </div>
  );
}
