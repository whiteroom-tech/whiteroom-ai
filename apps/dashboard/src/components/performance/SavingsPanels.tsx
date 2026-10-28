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
 * words; the same per day, with what each day saved, folds out under By day. Always the last 7 days,
 * whatever the page range; the header says so. `usdByDay` (engine
 * savingsByDay, absent on older engines) adds each day's dollars to its label.
 */
export function TokensCompare({ days, usdByDay, defaultOpen = false }: { days: DaySavings[]; usdByDay?: Record<string, number> | null; defaultOpen?: boolean }) {
  const [byDay, setByDay] = useState(defaultOpen);
  const byDayId = useId();
  const { used, without, saved } = tokenTotals(days);
  const energy = fmtEnergy(saved);
  const empty = without === 0;
  const max = Math.max(...days.map((d) => d.used + d.saved), 0);
  const h = (n: number) => (n > 0 ? Math.max(3, Math.round((n / max) * PLOT_H)) : 0);
  const fewer = fewerTokens(saved, used);
  const dayWords = days.map((d) => d.used + d.saved > 0
    ? `${weekdayLong(d.day)}: ${fmtTokens(d.used + d.saved)} without, ${fmtTokens(d.used)} with`
    : `${weekdayLong(d.day)}: no calls`).join('. ');

  return (
    <div className="wr-pcard wr-tokens" style={{ marginBottom: 16, overflow: 'hidden' }}>
      <div className="wr-tokens__head">
        <div style={{ minWidth: 0 }}>
          <h3 className="wr-pcard__title">Tokens: with WhiteRoom vs without</h3>
          <p className="wr-cap" style={{ margin: '2px 0 0' }}>What your agents sent to the models, compared with what they would have sent without WhiteRoom.</p>
        </div>
        <span className="wr-cap wr-tokens__meta">last 7 days{energy ? ` · ${energy} saved` : ''}</span>
      </div>
      {empty ? (
        <p className="wr-cap" style={{ margin: 0, padding: '0 20px 20px' }}>No model calls in the last 7 days.</p>
      ) : (
        <>
          <div className="wr-tokens__totals" role="img" aria-label={`Last 7 days: without WhiteRoom about ${fmtTokens(without)} tokens, with WhiteRoom ${fmtTokens(used)} tokens.${fewer ? ` ${fewer}.` : ''}`}>
            <span className="wr-lbl">Without WhiteRoom, est.</span>
            <div className="wr-tokens__track"><div className="wr-tokens__bar wr-tokens__bar--without" style={{ width: 'calc((100% - 72px) * 1)' }} /><strong>{fmtTokens(without)}</strong></div>
            <span className="wr-lbl" style={{ color: 'var(--tx)' }}>With WhiteRoom</span>
            <div className="wr-tokens__track"><div className="wr-tokens__bar wr-tokens__bar--with" style={{ width: `calc((100% - 72px) * ${(used / without).toFixed(3)})` }} /><strong>{fmtTokens(used)}</strong></div>
          </div>
          <p className="wr-tokens__diff">
            {fewer ? <strong style={{ color: 'var(--ok)' }}>{fewer}</strong> : <strong>Nothing saved yet</strong>}
            <span className="wr-cap"> · estimated</span>
          </p>
          <Disclosure label="By day" note={saved > 0 ? 'tokens with and without WhiteRoom, each day' : undefined} open={byDay} onToggle={() => setByDay((v) => !v)} controls={byDayId}>
          <div className="wr-tokens__byday">
          <div className="wr-tokens__days" role="img" aria-label={`Tokens per day. ${dayWords}.`}>
            {days.map((d) => {
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
            {days.map((d) => {
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
