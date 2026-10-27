'use client';

/**
 * Performance › Cost › Agent budgets: each agent's daily budget against
 * its spend today, and the calls the rest covers. A budget never stops an
 * agent; "Also add a Spend cap at this amount" adds one, in Record only.
 */
import { useCallback, useId, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Button, Hint, SelectChip, TextInput, FONT_MONO } from '@whiteroom/ui';
import { agentBudgetSet, agentBudgetsGet, governanceCreateRule, governanceList } from '@/lib/whiteroom/client';
import type { AgentBudgetForecast, AgentBudgetsResult, GovernanceRule } from '@/lib/whiteroom/types';
import { budgetsTotal, callsLeftText, capRuleFor, existingCap, MAX_AGENT_BUDGET_USD, parseBudget, refusalText } from '@/lib/agent-budgets';
import { fmtCost, fmtCount } from '@/lib/format';
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

/** What the card says after an action; `invalid` marks the amount field, `undo` puts a removed budget back. */
type Note = { tone: 'ok' | 'bad'; text: string; ruleId?: string; invalid?: boolean; undo?: { agentId: string; usd: number } };

const usdText = (usd: number) => fmtCost(usd * 1_000_000);

function Heading() {
  return <h3 style={{ ...H3, display: 'inline-flex', alignItems: 'center' }}>Agent budgets<Hint text={HELP.agentBudgets} /></h3>;
}

export function AgentBudgetsSection({ fleetId, authKey, agentIds, api = liveAgentBudgetsApi }: {
  fleetId: string;
  authKey?: string;
  /** Agents with calls in the page's range; agents that already have a budget are offered too. */
  agentIds: string[] | null;
  api?: AgentBudgetsApi;
}) {
  const [budgets, setBudgets] = useState<AgentBudgetForecast[] | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [agent, setAgent] = useState('');
  const [amount, setAmount] = useState('');
  const [alsoBlock, setAlsoBlock] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const noteId = useId();
  const capHintId = useId();
  // The fleet a save started for: an answer for another fleet is dropped.
  const fleetRef = useRef(fleetId);
  fleetRef.current = fleetId;

  const load = useCallback(async (stale: () => boolean) => {
    try {
      const res = await api.list(fleetId, authKey);
      if (!stale()) { setBudgets(res.agents); setUnsupported(false); setLoadFailed(false); }
    } catch (e) {
      if (stale()) return;
      // An engine without per-agent budgets doesn't know the action: the section stays hidden.
      const err = e as { status?: number; reason?: string };
      if (err.status === 400 && err.reason === 'Unknown action.') setUnsupported(true);
      // Anything else: say so, and keep figures already shown.
      else setLoadFailed(true);
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
    // The form only shows when there's an agent to pick, so `picked` is always set.
    if (usd === null) {
      setNote({ tone: 'bad', text: `Enter an amount in dollars, above 0 and up to ${fmtCount(MAX_AGENT_BUDGET_USD)}.`, invalid: true });
      amountRef.current?.focus();
      return;
    }
    const forFleet = fleetId;
    const current = () => fleetRef.current === forFleet;
    setBusy(true);
    setNote(null);
    try {
      try {
        await api.set(forFleet, picked, usd, authKey);
      } catch (e) {
        const plain = refusalText((e as { reason?: string }).reason);
        if (current()) setNote({ tone: 'bad', text: plain ? `Not saved. ${plain}` : 'Not saved. Try again.' });
        return;
      }
      const saved = `Budget for ${picked} set to ${usdText(usd)} a day.`;
      if (current()) { setAmount(''); setAlsoBlock(false); }
      if (!alsoBlock) { if (current()) setNote({ tone: 'ok', text: saved }); return; }
      // The budget is saved; the cap is its own step, and a failure there says only that.
      try {
        const already = existingCap(await api.rules(forFleet, authKey), picked, usd);
        const ruleId = already ? already.id : (await api.addCap(forFleet, picked, usd, authKey)).id;
        const text = already
          ? `${saved} A Spend cap at this amount is already set for ${picked}.`
          : `${saved} Added a Spend cap for ${picked} at this amount, in Record only: it shows what it would block. Turn on Block in Controls when you’re ready.`;
        if (current()) setNote({ tone: 'ok', text, ruleId });
      } catch (e) {
        const plain = refusalText((e as { reason?: string }).reason);
        if (current()) setNote({ tone: 'bad', text: `${saved} The Spend cap wasn’t added. ${plain ?? 'Add a Spend cap in Controls, or set the budget again with the box ticked.'}` });
      }
    } finally {
      setBusy(false);
      if (current()) refresh();
    }
  }

  /** Removes a budget; the note offers Undo with its amount. */
  async function remove(agentId: string, usd: number) {
    const forFleet = fleetId;
    const current = () => fleetRef.current === forFleet;
    setBusy(true);
    setNote(null);
    try {
      await api.set(forFleet, agentId, null, authKey);
      if (current()) { setNote({ tone: 'ok', text: `Budget for ${agentId} removed. Any Spend cap for it stays in Controls.`, undo: { agentId, usd } }); refresh(); }
    } catch {
      if (current()) setNote({ tone: 'bad', text: `Couldn’t remove the budget for ${agentId}. Try again.` });
    } finally {
      setBusy(false);
    }
  }

  async function undoRemove({ agentId, usd }: { agentId: string; usd: number }) {
    const forFleet = fleetId;
    const current = () => fleetRef.current === forFleet;
    setBusy(true);
    setNote(null);
    try {
      await api.set(forFleet, agentId, usd, authKey);
      if (current()) { setNote({ tone: 'ok', text: `Budget for ${agentId} set back to ${usdText(usd)} a day.` }); refresh(); }
    } catch {
      if (current()) setNote({ tone: 'bad', text: `Couldn’t put back the budget for ${agentId}. Set it again below.` });
    } finally {
      setBusy(false);
    }
  }

  if (unsupported) return null;
  if (budgets === null) {
    return loadFailed ? (
      <div style={CARD}>
        <Heading />
        <p role="status" style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>Couldn&rsquo;t load the budgets. Retrying&hellip;</p>
      </div>
    ) : null;
  }

  return (
    <div style={CARD}>
      <Heading />
      <p style={{ margin: '0 0 14px', fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>
        A daily figure for one agent, to see how far today&rsquo;s spend has gone. It never stops the agent; a Spend cap does.
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
              <Button variant="ghost" size={28} disabled={busy} onClick={() => void remove(b.agentId, b.budgetUsd)} aria-label={`Remove the budget for ${b.agentId}`}>Remove</Button>
            </li>
          ))}
        </ul>
      )}
      {budgets.length > 0 && (
        <p className="wr-agent-budgets-total" style={{ margin: '0 0 16px', fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>
          Agent budgets add up to <span style={{ fontFamily: FONT_MONO, color: 'var(--tx)' }}>{usdText(budgetsTotal(budgets))}</span> a day.
        </p>
      )}

      {options.length === 0 ? (
        <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>Agents show up here once they&rsquo;ve made calls.</p>
      ) : (
        <form
          onSubmit={(e) => { e.preventDefault(); void save(); }}
          className="wr-agent-budget-form"
          style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}
        >
          <SelectChip label="Agent" value={picked} onChange={setAgent} height={30} options={options.map((a) => ({ value: a, label: a }))} />
          {/* "$" and the amount stay together at any text size. */}
          <span style={{ display: 'inline-flex', flexWrap: 'nowrap', alignItems: 'center', gap: 6 }}>
            <span aria-hidden style={{ fontFamily: FONT_MONO, fontWeight: 600 }}>$</span>
            <TextInput
              ref={amountRef}
              ariaLabel="Daily budget in dollars"
              value={amount}
              onChange={(v) => { setAmount(v); if (note?.invalid) setNote(null); }}
              placeholder="per day"
              mono
              className="w-24 text-right"
              invalid={note?.invalid}
              describedBy={note?.invalid ? noteId : undefined}
            />
          </span>
          <span style={{ display: 'inline-flex', flexDirection: 'column' }}>
            <label className="wr-agent-budget-check" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-sm)', cursor: 'pointer', minHeight: 32, padding: '4px 6px 4px 0' }}>
              <input type="checkbox" checked={alsoBlock} onChange={(e) => setAlsoBlock(e.target.checked)} aria-describedby={capHintId} style={{ width: 16, height: 16, margin: 0, accentColor: 'var(--brand)' }} />
              Also add a Spend cap at this amount
            </label>
            <span id={capHintId} style={{ fontSize: 'var(--fs-xs)', color: 'var(--tx2)', paddingLeft: 24 }}>Starts in Record only. Turn on Block in Controls.</span>
          </span>
          <Button type="submit" variant="primary" size={32} busy={busy} busyLabel="Saving…">Set budget</Button>
        </form>
      )}

      {note && (
        <p id={noteId} role={note.tone === 'bad' ? 'alert' : 'status'} style={{ margin: '12px 0 0', fontSize: 'var(--fs-sm)', color: note.tone === 'bad' ? 'var(--bad)' : 'var(--tx)' }}>
          {note.text}
          {note.ruleId && <> <Link href={`${ROUTES.controls}?rule=${encodeURIComponent(note.ruleId)}`} className="wr-link" style={{ fontWeight: 600 }}>See the rule in Controls →</Link></>}
          {note.undo && <> <button type="button" className="wr-link wr-agent-budget-undo" disabled={busy} onClick={() => void undoRemove(note.undo!)} style={{ background: 'none', border: 0, padding: 0, font: 'inherit', fontWeight: 600, cursor: 'pointer' }}>Undo</button></>}
        </p>
      )}
    </div>
  );
}
