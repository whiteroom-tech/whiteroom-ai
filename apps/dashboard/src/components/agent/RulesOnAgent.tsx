'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { FONT_MONO, Hint, Panel } from '@whiteroom/ui';
import { governanceList } from '@/lib/whiteroom/client';
import type { GovernanceRule } from '@/lib/whiteroom/types';
import { usePoll } from '@/hooks/usePoll';
import { HELP } from '@/lib/metric-definitions';
import { ROUTES } from '@/lib/routes';
import { RULE_LABELS } from '@/lib/governance';
import { notSetUp, ruleCondition, rulesFor } from '@/lib/controls-view';
import { RuleDoesTag } from '@/components/RuleDoesTag';
import { plural } from '@/lib/format';

/**
 * The rules from Controls that cover this agent: the ones
 * that are on and set up, tagged the way Controls tags them, each linking to its rule.
 * Off rules and ones with nothing picked yet are counted, not listed, as Controls
 * puts them under "Off and not set up".
 */
export function RulesOnAgent({ fleetId, authKey, agentId, preview }: {
  fleetId: string;
  authKey?: string;
  agentId: string;
  /** /dev/agent sample: nothing is fetched. */
  preview?: GovernanceRule[];
}) {
  const [rules, setRules] = useState<GovernanceRule[] | null>(preview ?? null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async (stale: () => boolean) => {
    try {
      const res = await governanceList(fleetId, authKey);
      if (stale()) return;
      if (!Array.isArray(res.rules)) throw new Error('rules unavailable');
      setRules(res.rules);
      setFailed(false);
    } catch {
      if (!stale()) setFailed(true);
    }
  }, [fleetId, authKey]);
  usePoll(load, { intervalMs: 60_000, enabled: !!fleetId && !preview });

  const covering = rules ? rulesFor(rules, agentId) : [];
  const on = covering.filter((r) => r.mode !== 'off' && !notSetUp(r));
  const rest = restLine(covering.filter((r) => r.mode === 'off' && !notSetUp(r)).length, covering.filter(notSetUp).length);
  const controlsLink = `${ROUTES.controls}?agent=${encodeURIComponent(agentId)}`;
  return (
    <Panel
      title={<>Rules on this agent<Hint text={HELP.rulesThatApply} /></>}
      count={rules ? on.length : undefined}
      actions={<Link href={controlsLink} className="wr-link" style={{ fontSize: 'var(--fs-sm)' }}>Open in Controls &rarr;</Link>}
      bodyPadding={0}
    >
      {!rules ? (
        <p role={failed ? 'status' : undefined} style={{ margin: 0, padding: '14px 18px', fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>
          {failed ? 'Couldn’t load the rules. Retrying…' : 'Loading rules…'}
        </p>
      ) : on.length === 0 ? (
        <p style={{ margin: 0, padding: '14px 18px', fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>
          No rules are on for this agent.{rest ? ` ${rest}` : ''}
        </p>
      ) : (
        <>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {on.map((r) => {
              // The condition only, as on Controls; the tag beside the name says what the rule does.
              const s = ruleCondition(r);
              return (
                <li key={r.id} style={{ borderTop: '1px solid var(--line)' }}>
                  <Link href={`${ROUTES.controls}?rule=${encodeURIComponent(r.id)}`} className="wr-agent-rule">
                    <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>
                      {RULE_LABELS[r.ruleType]}
                      <RuleDoesTag rule={r} />
                    </span>
                    <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx)' }}>{s.pre}<span style={{ fontFamily: FONT_MONO }}>{s.val}</span>{s.post}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
          {rest && (
            <p style={{ margin: 0, padding: '10px 18px', borderTop: '1px solid var(--line)', fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>
              Also {rest}
            </p>
          )}
        </>
      )}
    </Panel>
  );
}

/** "1 rule is Off. 7 aren't set up yet." for the rules not listed; '' when there are none. */
export function restLine(off: number, unset: number): string {
  const offText = off > 0 ? `${off} ${plural(off, 'rule is', 'rules are')} Off.` : '';
  const unsetText = unset > 0 ? `${unset} ${off > 0 ? plural(unset, 'isn’t', 'aren’t') : plural(unset, 'rule isn’t', 'rules aren’t')} set up yet.` : '';
  return [offText, unsetText].filter(Boolean).join(' ');
}
