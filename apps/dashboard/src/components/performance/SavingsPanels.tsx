'use client';

import { useId, useState } from 'react';
import type { DaySavings } from '@/lib/analytics-metrics';
import { fmtCost, fmtEnergy, fmtTokens } from '@/lib/format';
import { fewerTokens, tokenTotals } from '@/lib/performance-overview';
import { Disclosure } from '@/app/(citadel)/performance/_components/primitives';

const PLOT_H = 100;

function weekday(day: string): string {
  return new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short' });
}
function weekdayLong(day: string): string {
  return new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long' });
}

/**
 * Tokens: with WhiteRoom vs without. Two total bars and the difference in
 * words, for the page's range when `range` is given (as Smaller context's card
 * above it), else for the 7 days; the same per day, with what each day saved,
 * folds out under By day, always the last 7 calendar days. `usdByDay` (engine
 * savingsByDay, absent on older engines) adds each day's dollars to its label.
 */
export function TokensCompare({ days, usdByDay, range, defaultOpen = false }: {
  /** Each day's input and saved tokens (the last 7 days); null when input per day is unknown: no By day. */
  days: DaySavings[] | null;
  usdByDay?: Record<string, number> | null;
  /** The page range's totals and its label ("last 24 h"); the bars and words follow it. */
  range?: { used: number; saved: number; label: string } | null;
  defaultOpen?: boolean;
}) {
  const [byDay, setByDay] = useState(defaultOpen);
  const byDayId = useId();
  const dayRows = days ?? [];
  const week = tokenTotals(dayRows);
  const { used, saved } = range ?? week;
  const without = used + saved;
  const label = range?.label ?? 'last 7 days';
  const energy = fmtEnergy(saved);
  const empty = without === 0;
  const max = Math.max(...dayRows.map((d) => d.used + d.saved), 0);
  const h = (n: number) => (n > 0 ? Math.max(3, Math.round((n / max) * PLOT_H)) : 0);
  const fewer = fewerTokens(saved, used);
  const dayWords = dayRows.map((d) => d.used + d.saved > 0
    ? `${weekdayLong(d.day)}: ${fmtTokens(d.used + d.saved)} without, ${fmtTokens(d.used)} with`
    : `${weekdayLong(d.day)}: no calls`).join('. ');

  return (
    <div className="wr-pcard wr-tokens" style={{ marginBottom: 16, overflow: 'hidden' }}>
      <div className="wr-tokens__head">
        <div style={{ minWidth: 0 }}>
          <h3 className="wr-pcard__title">Input tokens: with WhiteRoom vs without</h3>
          <p className="wr-cap" style={{ margin: '2px 0 0' }}>The input your agents sent to the models, with and without WhiteRoom. Includes cached input; output isn’t counted.</p>
        </div>
        <span className="wr-cap wr-tokens__meta">{label}{energy ? ` · ${energy} saved` : ''}</span>
      </div>
      {empty ? (
        <p className="wr-cap" style={{ margin: 0, padding: '0 20px 20px' }}>No model calls in the {label}.</p>
      ) : (
        <>
          <div className="wr-tokens__totals" role="img" aria-label={`${label.charAt(0).toUpperCase()}${label.slice(1)}: without WhiteRoom about ${fmtTokens(without)} tokens, with WhiteRoom ${fmtTokens(used)} tokens.${fewer ? ` ${fewer}.` : ''}`}>
            <span className="wr-lbl">Without WhiteRoom, est.</span>
            <div className="wr-tokens__track"><div className="wr-tokens__bar wr-tokens__bar--without" style={{ width: 'calc((100% - 72px) * 1)' }} /><strong>{fmtTokens(without)}</strong></div>
            <span className="wr-lbl" style={{ color: 'var(--tx)' }}>With WhiteRoom</span>
            <div className="wr-tokens__track"><div className="wr-tokens__bar wr-tokens__bar--with" style={{ width: `calc((100% - 72px) * ${(used / without).toFixed(3)})` }} /><strong>{fmtTokens(used)}</strong></div>
          </div>
          <p className="wr-tokens__diff">
            {fewer ? <strong style={{ color: 'var(--ok)' }}>{fewer}</strong> : <strong>Nothing saved yet</strong>}
            <span className="wr-cap"> · estimated</span>
          </p>
        </>
      )}
      {/* By day is the 7 days: it shows whenever they have calls, even when the picked range has none. */}
      {max > 0 && (
        <>
          <Disclosure label="By day" note={week.saved > 0 ? 'last 7 days, tokens with and without WhiteRoom each day' : undefined} open={byDay} onToggle={() => setByDay((v) => !v)} controls={byDayId}>
          <div className="wr-tokens__byday">
          <div className="wr-tokens__days" role="img" aria-label={`Tokens per day. ${dayWords}.`}>
            {dayRows.map((d) => {
              const wo = d.used + d.saved;
              return (
                <div key={d.day} className="wr-tokens__day" title={wo ? `${weekdayLong(d.day)}: ${fmtTokens(d.used)} with WhiteRoom, est. ${fmtTokens(wo)} without` : undefined}>
                  {wo ? (
                    <>
                      <div className="wr-tokens__col"><span className="wr-tokens__val">{fmtTokens(wo)}</span><div className="wr-tokens__vbar wr-tokens__bar--without" style={{ height: h(wo) }} /></div>
                      <div className="wr-tokens__col"><span className="wr-tokens__val wr-tokens__val--with">{fmtTokens(d.used)}</span><div className="wr-tokens__vbar wr-tokens__bar--with" style={{ height: h(d.used) }} /></div>
                    </>
                  ) : <span className="wr-cap" style={{ paddingBottom: 4, color: 'var(--tx3)' }}>—</span>}
                </div>
              );
            })}
          </div>
          <div className="wr-tokens__labels" aria-hidden="true">
            {dayRows.map((d) => {
              const usd = usdByDay?.[d.day];
              return (
                <div key={d.day}>
                  <div className="wr-cap">{weekday(d.day)}</div>
                  {d.saved > 0 && <div className="wr-cap wr-tokens__saved">{fmtTokens(d.saved)} saved</div>}
                  {d.saved > 0 && usd != null && usd > 0 && <div className="wr-cap wr-tokens__usd">{fmtCost(usd)}</div>}
                </div>
              );
            })}
          </div>
          <div className="wr-cap wr-tokens__legend">
            <span><span className="wr-tokens__key wr-tokens__bar--without" />Without WhiteRoom, est.</span>
            <span><span className="wr-tokens__key wr-tokens__bar--with" />With WhiteRoom</span>
          </div>
          </div>
          </Disclosure>
        </>
      )}
    </div>
  );
}
