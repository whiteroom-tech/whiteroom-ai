'use client';

/**
 * Performance › Control: what the rules caught, read only. Rule activity with
 * its split and the rules by mode on the left, the rules that caught the most
 * on the right, and every rule type and agent folded below.
 */
import { useId, useState } from 'react';
import Link from 'next/link';
import type { GovernanceRule, RuleActionCounts } from '@/lib/whiteroom/types';
import type { GovernanceCounts } from '@/lib/governance';
import { tallyTotal } from '@/lib/governance';
import { ruleAgentRows, ruleModeCounts, ruleTypeRows, topCaught } from '@/lib/performance-overview';
import { fmtCount } from '@/lib/format';
import { RULE_ACTIVITY } from '@/lib/vocab';
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
  const total = counts ? tallyTotal(counts) : 0;
  const top = topCaught(counts, byRuleId, rules);
  const extra = counts ? [
    counts.paused ? `${fmtCount(counts.paused)} paused` : '',
    counts.stopped ? `${fmtCount(counts.stopped)} stopped` : '',
    counts.toldYou ? `${fmtCount(counts.toldYou)} alerted` : '',
  ].filter(Boolean) : [];

  return (
    <div className="wr-pcard" style={{ overflow: 'hidden' }}>
      <div className="wr-ctrl">
        <div>
          <div className="wr-lbl">{RULE_ACTIVITY}</div>
          <div className="wr-num">{unavailable && !counts ? '—' : fmtCount(total)}</div>
          {counts ? (
            <div className="wr-cap">
              <strong className="wr-strong">{fmtCount(counts.blocks)}</strong> blocked · <strong className="wr-strong">{fmtCount(counts.wouldBlocks)}</strong> would have acted
              {extra.length > 0 && <> · {extra.join(' · ')}</>}
            </div>
          ) : <div className="wr-cap">{unavailable ? 'couldn’t load, retrying on the next refresh' : 'Loading…'}</div>}
          {rules && <div className="wr-cap" style={{ marginTop: 12 }}>{ruleModeCounts(rules)}</div>}
          <div className="wr-cap" style={{ marginTop: 4 }}><Link href={ROUTES.controls} className="wr-link">Suggestions in Controls →</Link></div>
        </div>
        <div>
          <div className="wr-lbl" style={{ marginBottom: 8 }}>What your rules caught most</div>
          {top.length === 0 ? (
            <p className="wr-cap" style={{ margin: 0 }}>{counts ? 'Nothing caught in this range.' : '—'}</p>
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
      </div>
      {counts && (
        <Disclosure label="All rules and agents" open={open} onToggle={() => setOpen((v) => !v)} controls={bodyId}>
          <AllRules counts={counts} />
        </Disclosure>
      )}
    </div>
  );
}

function AllRules({ counts }: { counts: GovernanceCounts }) {
  const types = ruleTypeRows(counts);
  const agents = ruleAgentRows(counts);
  return (
    <div className="wr-ctrl__all">
      <div className="wr-tablebox">
        <table className="wr-ptable">
          <thead><tr><th>Rule type</th><th className="is-r">Blocked</th><th className="is-r">Would have blocked</th></tr></thead>
          <tbody>
            {types.active.map((t) => (
              <tr key={t.label}><td>{t.label}</td><td className={`is-r${t.blocked ? '' : ' is-muted'}`}>{fmtCount(t.blocked)}</td><td className="is-r">{fmtCount(t.wouldBlock)}</td></tr>
            ))}
            {types.quiet.length > 0 && <tr><td className="wr-cap">{types.quiet.join(' · ')}</td><td className="is-r is-muted">0</td><td className="is-r is-muted">0</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="wr-tablebox">
        <table className="wr-ptable">
          <thead><tr><th>Agent</th><th className="is-r">Blocked</th><th className="is-r">Would have blocked</th></tr></thead>
          <tbody>
            {agents.length === 0
              ? <tr><td colSpan={3} className="wr-cap">No agent was caught in this range.</td></tr>
              : agents.map((a) => (
                <tr key={a.agent || '(none)'}>
                  <td>{a.agent ? <span className="wr-agent-name">{a.agent}</span> : <span className="wr-cap">Agents without a name</span>}</td>
                  <td className={`is-r${a.blocked ? '' : ' is-muted'}`}>{fmtCount(a.blocked)}</td>
                  <td className="is-r">{fmtCount(a.wouldBlock)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <p className="wr-cap" style={{ margin: 0, gridColumn: '1 / -1' }}>Blocked: a rule set to Block stopped the call. Would have blocked: a Record only rule matched and the call went through.</p>
    </div>
  );
}
