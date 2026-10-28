'use client';

/**
 * Performance › Cost › Cost prediction: one compact card, folded by default,
 * about one agent at a time. Pick an agent to see what it costs, then type a
 * daily budget or a token limit to see how many model calls that allows.
 * Saving keeps the budget for that agent. A budget only predicts and never
 * stops the agent; "Also add a Spend cap at this amount" adds a real rule, in
 * Watch.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Button, Hint, SelectChip, Toast } from '@whiteroom/ui';
import { agentBudgetSet, agentBudgetsGet, governanceCreateRule, governanceList } from '@/lib/whiteroom/client';
import type { AgentBudgetsResult, GovernanceRule } from '@/lib/whiteroom/types';
import { capRuleFor, existingCap, MAX_AGENT_BUDGET_USD, parseBudget, refusalText } from '@/lib/agent-budgets';
import {
  agentCostLine, allowsText, budgetsNote, defaultAgent, firstToRunOut, hasPrediction, MAX_AGENT_BUDGET_TOKENS, parseTokenBudget,
  pickableAgents, todayLine, unitsAllowed, unitWord,
} from '@/lib/cost-prediction';
import { fmtCost, fmtCount } from '@/lib/format';
import { ROUTES } from '@/lib/routes';
import { usePoll } from '@/hooks/usePoll';
import { Disclosure } from './primitives';
import { predictionNote, type WorkingHourRate } from '@/lib/performance-overview';
import { HELP } from '@/lib/metric-definitions';

/** What the card reads and writes. The dev preview passes its own, so a sample fleet is never written to. */
export interface CostPredictionApi {
  list: (fleetId: string, key?: string) => Promise<AgentBudgetsResult>;
  /** `tokens` undefined keeps the stored token limit (engines without one ignore it). */
  setBudget: (fleetId: string, agentId: string, usd: number | null, key?: string, tokens?: number | null) => Promise<void>;
  rules: (fleetId: string, key?: string) => Promise<GovernanceRule[]>;
  addCap: (fleetId: string, agentId: string, usd: number, key?: string) => Promise<GovernanceRule>;
}

export const liveCostPredictionApi: CostPredictionApi = {
  list: (fleetId, key) => agentBudgetsGet(fleetId, key, { allAgents: true }),
  setBudget: agentBudgetSet,
  rules: async (fleetId, key) => (await governanceList(fleetId, key)).rules,
  addCap: async (fleetId, agentId, usd, key) => (await governanceCreateRule(fleetId, capRuleFor(agentId, usd), key)).rule,
};

export function CostPredictionSection({ fleetId, authKey, agentIds, fleetHourly, api = liveCostPredictionApi, defaultOpen = false }: {
  fleetId: string;
  authKey?: string;
  /** Agents with calls in the page's range: an older engine lists only agents with a budget. */
  agentIds: string[] | null;
  /** The whole fleet's spend per working hour, for the folded note; absent or null when unknown. */
  fleetHourly?: WorkingHourRate | null;
  api?: CostPredictionApi;
  /** Starts unfolded (dev preview). */
  defaultOpen?: boolean;
}) {
  const [data, setData] = useState<AgentBudgetsResult | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [open, setOpen] = useState(defaultOpen);
  const [picked, setPicked] = useState('');
  const [usd, setUsd] = useState('');
  const [tok, setTok] = useState('');
  const [alsoCap, setAlsoCap] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; field?: 'usd' | 'tok' } | null>(null);
  const [toast, setToast] = useState<{ text: string; ruleId?: string } | null>(null);
  const bodyId = useId();
  const errId = useId();
  const usdId = useId();
  const tokId = useId();
  // The fleet a save started for: an answer for another fleet is dropped.
  const fleetRef = useRef(fleetId);
  fleetRef.current = fleetId;

  const load = useCallback(async (stale: () => boolean) => {
    try {
      const res = await api.list(fleetId, authKey);
      if (!stale()) { setData(res); setUnsupported(false); setLoadFailed(false); }
    } catch (e) {
      if (stale()) return;
      // An engine without per-agent budgets doesn't know the action: the card stays hidden.
      const err = e as { status?: number; reason?: string };
      if (err.status === 400 && err.reason === 'Unknown action.') setUnsupported(true);
      else setLoadFailed(true);
    }
  }, [fleetId, authKey, api]);
  const { refresh } = usePoll(load, { intervalMs: 60_000 });

  const agents = useMemo(() => (data ? pickableAgents(data, agentIds) : []), [data, agentIds]);
  const agent = picked && agents.some((a) => a.agentId === picked) ? picked : defaultAgent(agents);
  const f = agents.find((a) => a.agentId === agent) ?? null;

  // The boxes show the picked agent's saved figures; a poll never overwrites what's being typed.
  const shownFor = useRef<string | null>(null);
  useEffect(() => {
    if (!f || shownFor.current === f.agentId) return;
    shownFor.current = f.agentId;
    setUsd(f.budgetUsd != null ? String(f.budgetUsd) : '');
    setTok(f.budgetTokens != null ? String(f.budgetTokens) : '');
    setAlsoCap(false);
    setError(null);
  }, [f]);

  if (unsupported) return null;

  const predicted = hasPrediction(data);
  const unit = unitWord(data?.unit);
  const usdVal = parseBudget(usd);
  const tokVal = parseTokenBudget(tok);
  const byUsd = unitsAllowed(usdVal, f?.costPerTaskUsd);
  const byTokens = unitsAllowed(tokVal, f?.tokensPerTask);
  const cost = f ? agentCostLine(f, unit, data?.rateLookbackHours) : null;
  const today = f ? todayLine(f, unit) : null;
  const first = firstToRunOut(byUsd, byTokens);
  // Older engines: no per-call rate, so nothing to compute from typed amounts.
  const noRate = 'Shows once it has a few priced calls';

  async function save() {
    if (!f) return;
    const name = f.agentId;
    if (usd.trim() !== '' && usdVal === null) { setError({ text: `Enter a daily budget in dollars, above 0 and up to ${fmtCount(MAX_AGENT_BUDGET_USD)}, or leave it empty.`, field: 'usd' }); return; }
    if (predicted && tok.trim() !== '' && tokVal === null) { setError({ text: `Enter a whole number of tokens, above 0 and up to ${fmtCount(MAX_AGENT_BUDGET_TOKENS)}, or leave it empty.`, field: 'tok' }); return; }
    const newTok = predicted ? (tok.trim() === '' ? null : tokVal) : undefined;
    if (usdVal === null && newTok != null) { setError({ text: 'A token limit goes with a daily budget in dollars. Add one, or clear the tokens.', field: 'usd' }); return; }
    const forFleet = fleetId;
    const current = () => fleetRef.current === forFleet;
    setBusy(true);
    setError(null);
    try {
      const changed = usdVal !== f.budgetUsd || (newTok !== undefined && newTok !== (f.budgetTokens ?? null));
      if (changed && !(usdVal === null && f.budgetUsd == null)) await api.setBudget(forFleet, name, usdVal, authKey, newTok);
    } catch (e) {
      const plain = refusalText((e as { reason?: string }).reason);
      if (current()) setError({ text: plain ? `Not saved. ${plain}` : 'Not saved. Try again.' });
      setBusy(false);
      return;
    }
    const saved = usdVal === null ? `Budget for ${name} removed.` : `Saved for ${name}.`;
    const done = (text: string, ruleId?: string) => { if (current()) { setToast({ text, ruleId }); setAlsoCap(false); shownFor.current = null; refresh(); } };
    if (!alsoCap || usdVal === null) { setBusy(false); done(saved); return; }
    // The budget is saved; the cap is its own step, and a failure there says only that.
    try {
      const already = existingCap(await api.rules(forFleet, authKey), name, usdVal);
      const ruleId = already ? already.id : (await api.addCap(forFleet, name, usdVal, authKey)).id;
      done(already ? `${saved} A Spend cap at this amount is already set.` : `${saved} Added a Spend cap at ${fmtCost(usdVal * 1_000_000)} a day, in Watch.`, ruleId);
    } catch (e) {
      const plain = refusalText((e as { reason?: string }).reason);
      done(`${saved} The Spend cap wasn’t added. ${plain ?? 'Add a Spend cap in Controls.'}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wr-pcard" style={{ overflow: 'hidden', marginBottom: 16 }}>
      <Disclosure label="Cost prediction" note={predictionNote(fleetHourly, data ? budgetsNote(agents) : loadFailed ? 'couldn’t load, retrying' : undefined)} open={open} onToggle={() => setOpen((v) => !v)} controls={bodyId} first>
        <div className="wr-pred">
          {agents.length === 0 ? (
            <p className="wr-cap" style={{ margin: 0 }}>{data ? 'Agents show up here once they’ve made calls.' : loadFailed ? 'Couldn’t load the cost prediction. Retrying…' : 'Loading…'}</p>
          ) : (
            <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="wr-pred__form">
              <div className="wr-pred__agent">
                <SelectChip label="Agent" value={agent} onChange={(v) => setPicked(v)} height={30} options={agents.map((a) => ({ value: a.agentId, label: a.agentId }))} />
                <span className="wr-cap"><span className="wr-lbl" style={{ marginRight: 6 }}>{f?.burnRateUsdPerHour ? <>Hourly cost<Hint text={HELP.hourlySpend} size={12} /></> : 'Cost'}</span><span style={{ color: 'var(--tx)' }}>{cost ?? 'No priced calls yet to estimate from.'}</span></span>
              </div>
              <div className="wr-pred__fields">
                <label className="wr-pred__field" htmlFor={usdId}>
                  <span className="wr-lbl">Daily budget ($)</span>
                  <input id={usdId} className="wr-input" inputMode="decimal" value={usd} placeholder="e.g. 20"
                    onChange={(e) => { setUsd(e.target.value); if (error) setError(null); }}
                    aria-invalid={error?.field === 'usd' || undefined} aria-describedby={error?.field === 'usd' ? errId : undefined} />
                  <span className="wr-cap">{byUsd != null ? `${allowsText(byUsd, unit)} a day` : usdVal != null ? noRate : `Enter a budget to see how many ${unit}s it allows.`}</span>
                </label>
                {predicted && (
                  <label className="wr-pred__field" htmlFor={tokId}>
                    <span className="wr-lbl">Token limit <span className="wr-cap" style={{ fontWeight: 400 }}>a day, optional</span></span>
                    <input id={tokId} className="wr-input" inputMode="numeric" value={tok} placeholder="e.g. 10000000"
                      onChange={(e) => { setTok(e.target.value); if (error) setError(null); }}
                      aria-invalid={error?.field === 'tok' || undefined} aria-describedby={error?.field === 'tok' ? errId : undefined} />
                    <span className="wr-cap">{byTokens != null ? `${allowsText(byTokens, unit)} a day` : tokVal != null ? noRate : `Enter a token limit to see how many ${unit}s it allows.`}</span>
                  </label>
                )}
              </div>
              {first && <p className="wr-cap" style={{ margin: 0, color: 'var(--tx)' }}>{first}</p>}
              {today && <p className="wr-cap" style={{ margin: 0 }}>{today}</p>}
              <label className="wr-pred__check">
                <input type="checkbox" checked={alsoCap} disabled={usdVal === null} onChange={(e) => setAlsoCap(e.target.checked)} />
                <span>Also add a Spend cap at this amount <span className="wr-cap">(starts in Watch)</span></span>
              </label>
              <p className="wr-cap" style={{ margin: 0 }}>
                A budget never stops {agent}. To stop it, <Link href={ROUTES.controls} className="wr-link">set a spend cap</Link>.
              </p>
              {error && <p id={errId} role="alert" className="wr-cap" style={{ margin: 0, color: 'var(--bad)' }}>{error.text}</p>}
              <div><Button type="submit" variant="primary" size={32} busy={busy} busyLabel="Saving…">Save for {agent}</Button></div>
            </form>
          )}
        </div>
      </Disclosure>
      {toast && (
        <Toast
          message={<>{toast.text}{toast.ruleId && <> <Link href={`${ROUTES.controls}?rule=${encodeURIComponent(toast.ruleId)}`} className="wr-link">See the rule →</Link></>}</>}
          onClose={() => setToast(null)}
        />
      )}
    </div>
  );
}
