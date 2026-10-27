'use client';

/**
 * Performance › Cost tracking: the fleet's burn rate and how many tasks its
 * daily budgets have left. Its own full-width row under the four numbers.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Hint, TextInput, FONT_MONO } from '@whiteroom/ui';
import { performanceCostForecast, setBudgetUsd, setTokenBudget } from '@/lib/whiteroom/client';
import type { PerformanceCostForecastResult, SetBudgetResult, SetTokenBudgetResult } from '@/lib/whiteroom/types';
import { budgetNotice, burnCaption, remainingTasksNoteFor, resolveTasksLeft, tasksLeftColor } from '@/lib/cost-tracking';
import Link from 'next/link';
import { ROUTES } from '@/lib/routes';
import { fmtCost, fmtCount } from '@/lib/format';
import { HELP } from '@/lib/metric-definitions';
import { usePoll } from '@/hooks/usePoll';
import { CARD, H3 } from './primitives';

/** True while the input identified by this aria-label has focus. */
function editing(ariaLabel: string): boolean {
  return typeof document !== 'undefined' && document.activeElement?.getAttribute('aria-label') === ariaLabel;
}

/**
 * Where the card reads and saves. With `preview` (the dev preview's sample
 * fleet) nothing touches the network: reads return the sample with any budgets
 * saved since, saves stay local, so a made-up fleet id is never written to.
 */
export function costTrackingApi(preview?: PerformanceCostForecastResult) {
  if (preview) {
    // Saved budgets live here for the page's life, so an edit stays put after the refresh that follows it.
    let current = preview;
    return {
      forecast: async (): Promise<PerformanceCostForecastResult> => current,
      saveBudgetUsd: async (fleetId: string, budgetUsd: number | null): Promise<SetBudgetResult> => { current = { ...current, budgetUsd }; return { success: true, fleetId, budgetUsd }; },
      saveTokenBudget: async (fleetId: string, tokenBudget: number | null): Promise<SetTokenBudgetResult> => { current = { ...current, tokenBudget }; return { success: true, fleetId, tokenBudget }; },
    };
  }
  return {
    forecast: (fleetId: string, authKey?: string) => performanceCostForecast(fleetId, undefined, authKey),
    saveBudgetUsd: setBudgetUsd,
    saveTokenBudget: setTokenBudget,
  };
}

// The fleet's budget vs. spend to date. Backs onto performanceCostForecast
// (which also carries a per-task-type $/task breakdown — deliberately not
// shown here; a single "what's left" figure is what this card is for).
export function CostTrackingSection({ fleetId, authKey, preview }: {
  fleetId: string;
  authKey?: string;
  /** Sample data for the dev preview: shown as is, never fetched, and budget edits are never saved. */
  preview?: PerformanceCostForecastResult;
}) {
  const [forecast, setForecast] = useState<PerformanceCostForecastResult | null>(preview ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [budgetDraft, setBudgetDraft] = useState(preview?.budgetUsd != null ? String(preview.budgetUsd) : '');
  const [tokenBudgetDraft, setTokenBudgetDraft] = useState(preview?.tokenBudget != null ? String(preview.tokenBudget) : '');
  // Set once the operator edits a draft; cleared on commit. While set (or while
  // the input is focused), polls must not overwrite what they are typing.
  const budgetDirty = useRef(false);
  const tokenBudgetDirty = useRef(false);
  // A failed save keeps the typed value (still dirty, so polls leave it
  // alone and the next commit retries) but says plainly it wasn't saved.
  const [budgetSaveError, setBudgetSaveError] = useState<string | null>(null);

  const api = useMemo(() => costTrackingApi(preview), [preview]);

  const fetchForecast = useCallback(async (stale: () => boolean) => {
    try {
      const data = await api.forecast(fleetId, authKey);
      if (stale()) return;
      if (data.error) { setLoadError(data.error); return; }
      setLoadError(null);
      setForecast(data);
      if (!budgetDirty.current && !editing('Fleet budget in USD')) setBudgetDraft(data.budgetUsd != null ? String(data.budgetUsd) : '');
      if (!tokenBudgetDirty.current && !editing('Fleet token budget')) setTokenBudgetDraft(data.tokenBudget != null ? String(data.tokenBudget) : '');
    } catch {
      if (!stale()) setLoadError('Could not reach the cost-tracking endpoint.');
    }
  }, [fleetId, authKey, api]);

  const { refresh: refreshForecast } = usePoll(fetchForecast, { intervalMs: 60000 });

  // usePoll fires on mount and on each tick with the latest fetchForecast, but
  // its interval doesn't restart on identity change — refetch promptly if the
  // fleet (or key) this card points at changes.
  const forecastFirstRun = useRef(true);
  useEffect(() => {
    if (forecastFirstRun.current) { forecastFirstRun.current = false; return; }
    refreshForecast();
  }, [fetchForecast, refreshForecast]);

  async function commitBudget(value: string) {
    const trimmed = value.trim();
    const n = trimmed === '' ? null : Number(trimmed);
    if (n != null && !(n > 0)) { budgetDirty.current = false; setBudgetDraft(forecast?.budgetUsd != null ? String(forecast.budgetUsd) : ''); return; }
    try {
      const res = await api.saveBudgetUsd(fleetId, n, authKey);
      if (res.error || res.success === false) throw new Error(res.error);
      budgetDirty.current = false;
      setBudgetSaveError(null);
      refreshForecast();
    } catch {
      const saved = forecast?.budgetUsd != null ? `$${forecast.budgetUsd}` : 'not set';
      setBudgetSaveError(`Budget not saved — it is still ${saved}. Press Enter to retry.`);
    }
  }

  async function commitTokenBudget(value: string) {
    const trimmed = value.trim();
    const n = trimmed === '' ? null : Number(trimmed);
    if (n != null && !(n > 0)) { tokenBudgetDirty.current = false; setTokenBudgetDraft(forecast?.tokenBudget != null ? String(forecast.tokenBudget) : ''); return; }
    try {
      const res = await api.saveTokenBudget(fleetId, n, authKey);
      if (res.error || res.success === false) throw new Error(res.error);
      tokenBudgetDirty.current = false;
      setBudgetSaveError(null);
      refreshForecast();
    } catch {
      const saved = forecast?.tokenBudget != null ? `${fmtCount(forecast.tokenBudget)} tokens` : 'not set';
      setBudgetSaveError(`Token budget not saved — it is still ${saved}. Press Enter to retry.`);
    }
  }

  if (loadError) {
    return (
      <div style={CARD}>
        <h3 style={{ ...H3, display: 'inline-flex', alignItems: 'center' }}>Cost prediction<Hint text={HELP.costTracking} /></h3>
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--bad)' }}>
          Couldn&rsquo;t load the cost prediction: {loadError}
          {loadError === 'Unknown action.' && ' — the backend hasn’t been deployed with this feature yet.'}
        </div>
      </div>
    );
  }

  if (!forecast) return null; // still loading the first response

  return (
    <div style={CARD}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ ...H3, display: 'inline-flex', alignItems: 'center' }}>Cost prediction<Hint text={HELP.costTracking} /></h3>
        {/* Both budgets are always editable — dollar and token tasks-left are
            tracked independently, so a fleet can set either or both, and
            which one is actually usable can change as pricing coverage does. */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap" title="Used to estimate calls remaining. It never stops spending; to set a limit, add a Spend cap in Controls.">
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--tx2)', letterSpacing: 0.5 }}>FLEET BUDGET PER DAY</span>
            {/* "$" and the amount stay together at any text size. */}
            <span className="inline-flex items-center gap-2" style={{ flexWrap: 'nowrap' }}>
              <span aria-hidden style={{ fontFamily: FONT_MONO, fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--tx)' }}>$</span>
              <TextInput ariaLabel="Fleet budget in USD" value={budgetDraft} onChange={v => { budgetDirty.current = true; setBudgetDraft(v); }} onCommit={commitBudget} placeholder="not set" mono className="w-24 text-right" />
            </span>
          </div>
          <div className="flex items-center gap-2 flex-wrap" title="For a model with no $/token price on file yet — tracks calls left in tokens instead of dollars.">
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--tx2)', letterSpacing: 0.5 }}>FLEET TOKENS PER DAY</span>
            <TextInput ariaLabel="Fleet token budget" value={tokenBudgetDraft} onChange={v => { tokenBudgetDirty.current = true; setTokenBudgetDraft(v); }} onCommit={commitTokenBudget} placeholder="not set" mono className="w-28 text-right" />
          </div>
        </div>
      </div>
      {/* Always said: these numbers track spending, they don't limit it. */}
      <p style={{ margin: '-4px 0 14px', fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>
        The fleet&rsquo;s budget is for tracking only. It never stops your agents. To set a limit,{' '}
        <Link href={ROUTES.controls} className="wr-link" style={{ fontWeight: 600 }}>add a Spend cap in Controls →</Link>
      </p>
      {(() => {
        const notice = budgetNotice(forecast);
        return notice && (
          <div role="status" style={{ margin: '0 0 14px', padding: '9px 12px', borderRadius: 6, background: 'var(--warn-bg)', border: '1px solid var(--warn-line)', fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--warn-tx)' }}>
            {notice}
          </div>
        );
      })()}
      {budgetSaveError && (
        <div role="alert" style={{ fontSize: 'var(--fs-sm)', color: 'var(--bad)', margin: '-4px 0 12px' }}>{budgetSaveError}</div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 16 }}>
        <div>
          <div style={{ fontSize: 'var(--fs-xl)', fontWeight: 700, fontFamily: FONT_MONO, color: 'var(--tx)' }}>
            {/* Same money format as the Spend card, so a small rate isn't rounded to $0.01. */}
            {fmtCost(Math.round(forecast.burnRateUsdPerHour * 1_000_000))} / h
          </div>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--tx2)' }}>{burnCaption(forecast)}</div>
        </div>
        {(() => {
          const dollar = resolveTasksLeft(forecast, 'dollar');
          const token = resolveTasksLeft(forecast, 'token');
          return (
            <>
              <TasksLeftCell value={dollar.value} note={remainingTasksNoteFor(dollar.reason, 'dollar')} label="calls left in today’s budget" />
              <TasksLeftCell value={token.value} note={remainingTasksNoteFor(token.reason, 'token')} label="calls left in today’s token budget" />
            </>
          );
        })()}
      </div>
    </div>
  );
}

/** One of the two tasks-left figures (dollar or token budget) — shares its render with the old combined field. */
function TasksLeftCell({ value, note, label }: { value: number | null; note: string; label: string }) {
  if (value == null) {
    return (
      <div>
        <div style={{ fontSize: 'var(--fs-xl)', fontWeight: 700, fontFamily: FONT_MONO, color: 'var(--tx3)' }}>—</div>
        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--tx3)' }}>{note}</div>
      </div>
    );
  }
  return (
    <div>
      <div style={{ fontSize: 'var(--fs-xl)', fontWeight: 700, fontFamily: FONT_MONO, color: tasksLeftColor(value) }}>
        {value}
      </div>
      <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--tx3)' }}>{label}</div>
    </div>
  );
}
