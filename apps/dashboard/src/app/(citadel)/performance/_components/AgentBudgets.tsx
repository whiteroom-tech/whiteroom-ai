'use client';

/**
 * Performance › Cost › Budgets per agent: each agent's daily budget against
 * its spend today, and the calls the rest covers. A budget never stops an
 * agent; "Also block at this amount" adds a Spend cap for it, in Record only.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Button, Hint, SelectChip, TextInput, FONT_MONO } from '@whiteroom/ui';
import { agentBudgetSet, agentBudgetsGet, governanceCreateRule, governanceList } from '@/lib/whiteroom/client';
import type { AgentBudgetForecast, AgentBudgetsResult, GovernanceRule } from '@/lib/whiteroom/types';
import { callsLeftText, capRuleFor, existingCap, MAX_AGENT_BUDGET_USD, parseBudget } from '@/lib/agent-budgets';
import { fmtCost } from '@/lib/format';
import { HELP } from '@/lib/metric-definitions';
import { ROUTES } from '@/lib/routes';
import { usePoll } from '@/hooks/usePoll';
import { CARD, H3 } from './primitives';

/** What the card reads and writes. The dev preview passes its own, so a sample fleet is never written to. */
export interface AgentBudgetsApi {
  list: (fleetId: string, key?: string) => Promise<AgentBudgetsResult>;
  set: (fleetId: string, agentId: string, usd: number | null, key?: string) => Promise<void>;
  rules: (fleetId: string, key?: string) => Promise<GovernanceRule[]>;
  addCap: (fleetId: string, agentId: string, usd: number, key?: string) => Promise<GovernanceRule>;
}

export const liveAgentBudgetsApi: AgentBudgetsApi = {
  list: agentBudgetsGet,
  set: agentBudgetSet,
  rules: async (fleetId, key) => (await governanceList(fleetId, key)).rules,
  addCap: async (fleetId, agentId, usd, key) => (await governanceCreateRule(fleetId, capRuleFor(agentId, usd), key)).rule,
};

type Note = { tone: 'ok' | 'bad'; text: string; ruleId?: string };

export function AgentBudgetsSection({ fleetId, authKey, agentIds, api = liveAgentBudgetsApi }: {
  fleetId: string;
  authKey?: string;
  /** Agents with calls in the page's range; agents that already have a budget are offered too. */
  agentIds: string[] | null;
  api?: AgentBudgetsApi;
}) {
  const [budgets, setBudgets] = useState<AgentBudgetForecast[] | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [agent, setAgent] = useState('');
  const [amount, setAmount] = useState('');
  const [alsoBlock, setAlsoBlock] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  // The fleet a save started for: an answer for another fleet is dropped.
  const fleetRef = useRef(fleetId);
  fleetRef.current = fleetId;

  const load = useCallback(async (stale: () => boolean) => {
    try {
      const res = await api.list(fleetId, authKey);
      if (!stale()) { setBudgets(res.agents); setUnsupported(false); }
    } catch (e) {
      // An engine without per-agent budgets answers "Unknown action.": the section stays hidden.
      if (!stale() && (e as { reason?: string }).reason === 'Unknown action.') setUnsupported(true);
    }
  }, [fleetId, authKey, api]);
  const { refresh } = usePoll(load, { intervalMs: 60_000 });

  const options = useMemo(() => {
    const ids = new Set([...(agentIds ?? []), ...(budgets ?? []).map((b) => b.agentId)]);
    return [...ids].sort((a, b) => a.localeCompare(b));
  }, [agentIds, budgets]);
  const picked = agent || options[0] || '';

  async function save() {
    const usd = parseBudget(amount);
    if (!picked || usd === null) { setNote({ tone: 'bad', text: `Enter an amount in dollars, above 0 and up to ${MAX_AGENT_BUDGET_USD.toLocaleString('en-US')}.` }); return; }
    const forFleet = fleetId;
    setBusy(true);
    setNote(null);
    try {
      await api.set(forFleet, picked, usd, authKey);
      let text = `Budget for ${picked} set to ${fmtCost(usd * 1_000_000)} a day.`;
      let ruleId: string | undefined;
      if (alsoBlock) {
        const already = existingCap(await api.rules(forFleet, authKey), picked, usd);
        if (already) {
          text += ` A Spend cap at this amount is already set for ${picked}.`;
          ruleId = already.id;
        } else {
          ruleId = (await api.addCap(forFleet, picked, usd, authKey)).id;
          text += ` Added a Spend cap for ${picked} at this amount, in Record only: it shows what it would block. Turn on Block in Controls when you’re ready.`;
        }
      }
      if (fleetRef.current !== forFleet) return;
      setNote({ tone: 'ok', text, ruleId });
      setAmount('');
      setAlsoBlock(false);
      refresh();
    } catch (e) {
      if (fleetRef.current !== forFleet) return;
      const reason = (e as { reason?: string }).reason;
      setNote({ tone: 'bad', text: reason ? `Not saved: ${reason}` : 'Not saved. Try again.' });
      refresh();
    } finally {
      if (fleetRef.current === forFleet) setBusy(false);
    }
  }

  async function remove(agentId: string) {
    setBusy(true);
    setNote(null);
    try {
      await api.set(fleetId, agentId, null, authKey);
      setNote({ tone: 'ok', text: `Budget for ${agentId} removed. Any Spend cap for it stays in Controls.` });
      refresh();
    } catch {
      setNote({ tone: 'bad', text: `Couldn’t remove the budget for ${agentId}. Try again.` });
    } finally {
      setBusy(false);
    }
  }

  if (unsupported || budgets === null) return null;

  return (
    <div style={CARD}>
      <h3 style={{ ...H3, display: 'inline-flex', alignItems: 'center' }}>Budgets per agent<Hint text={HELP.agentBudgets} /></h3>
      <p style={{ margin: '0 0 14px', fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>
        A daily figure for one agent, to see how far today&rsquo;s spend has gone. It doesn&rsquo;t stop the agent unless you also block at the amount.
      </p>

      {budgets.length > 0 && (
        <ul style={{ listStyle: 'none', margin: '0 0 16px', padding: 0, display: 'flex', flexDirection: 'column' }}>
          {budgets.map((b) => (
            <li key={b.agentId} className="wr-agent-budget">
              <span style={{ fontFamily: FONT_MONO, fontWeight: 500, overflowWrap: 'anywhere' }}>{b.agentId}</span>
              <span style={{ fontFamily: FONT_MONO }}>
                {fmtCost(b.spentTodayUsd * 1_000_000)} <span style={{ color: 'var(--tx2)' }}>of {fmtCost(b.budgetUsd * 1_000_000)} today</span>
              </span>
              <span style={{ fontSize: 'var(--fs-sm)', color: b.spentTodayUsd >= b.budgetUsd ? 'var(--warn)' : 'var(--tx2)' }}>
                {b.spentTodayUsd >= b.budgetUsd ? 'Over today’s budget' : callsLeftText(b)}
              </span>
              <Button variant="ghost" size={28} disabled={busy} onClick={() => void remove(b.agentId)} aria-label={`Remove the budget for ${b.agentId}`}>Remove</Button>
            </li>
          ))}
        </ul>
      )}

      {options.length === 0 ? (
        <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>Agents show up here once they&rsquo;ve made calls.</p>
      ) : (
        <form
          onSubmit={(e) => { e.preventDefault(); void save(); }}
          style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}
        >
          <SelectChip label="Agent" value={picked} onChange={setAgent} height={30} options={options.map((a) => ({ value: a, label: a }))} />
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span aria-hidden style={{ fontFamily: FONT_MONO, fontWeight: 600 }}>$</span>
            <TextInput ariaLabel="Daily budget in dollars" value={amount} onChange={setAmount} placeholder="per day" mono className="w-24 text-right" />
          </span>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-sm)', cursor: 'pointer', minHeight: 32 }}>
            <input type="checkbox" checked={alsoBlock} onChange={(e) => setAlsoBlock(e.target.checked)} style={{ width: 16, height: 16, margin: 0, accentColor: 'var(--brand)' }} />
            Also block at this amount
          </label>
          <Button type="submit" variant="primary" size={32} busy={busy} busyLabel="Saving…">Set budget</Button>
        </form>
      )}

      {note && (
        <p role={note.tone === 'bad' ? 'alert' : 'status'} style={{ margin: '12px 0 0', fontSize: 'var(--fs-sm)', color: note.tone === 'bad' ? 'var(--bad)' : 'var(--tx)' }}>
          {note.text}{' '}
          {note.ruleId && <Link href={`${ROUTES.controls}?rule=${encodeURIComponent(note.ruleId)}`} className="wr-link" style={{ fontWeight: 600 }}>See the rule in Controls →</Link>}
        </p>
      )}
    </div>
  );
}
