'use client';

import { useId, useState, type ReactNode } from 'react';
import type { DaySavings } from '@/lib/analytics-metrics';
import { fmtCost, fmtEnergy, fmtTokens } from '@/lib/format';
import { formatDayKey } from '@/lib/zone-time';
import { fewerTokens, inRange, tokenTotals } from '@/lib/performance-overview';
import { Disclosure } from '@/app/(citadel)/performance/_components/primitives';

const PLOT_H = 100;

function weekday(day: string): string {
  return formatDayKey(day, { weekday: 'short' });
}
function weekdayLong(day: string): string {
  return formatDayKey(day, { weekday: 'long' });
}

/**
 * Cost › Input sent to your models: the input tokens with WhiteRoom and the
 * estimate without, always on show, for the page's range when `range` is given,
 * else for the 7 days. Under them, folded, the same per day with what each day
 * saved: always the last 7 calendar days, whatever the range, so its label says so.
 * `usdByDay` adds each day's dollars to its label.
 */
export function TokensCompare({ days, usdByDay, range, unavailable = false, note, defaultOpen = false }: {
  /** Each day's input and saved tokens (the last 7 days); null when input per day is unknown: no By day. */
  days: DaySavings[] | null;
  usdByDay?: Record<string, number> | null;
  /** The page range's totals and its label ("last 24 h"); the bars and words follow it. */
  range?: { used: number; saved: number; label: string } | null;
  /** The range's figures couldn't be read: no bars (never the 7 days' under another range's name). */
  unavailable?: boolean;
  /** A line under the bars (what the Spend figure is missing). */
  note?: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
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
        <h3 className="wr-pcard__title">Input sent to your models</h3>
        {!unavailable && fewer && <span className="wr-cap wr-tokens__saved">{fewer}</span>}
      </div>
      {unavailable ? (
        <p className="wr-cap" style={{ margin: 0, padding: '0 20px 16px' }}>Couldn’t load, retrying on the next refresh.</p>
      ) : empty ? (
        <p className="wr-cap" style={{ margin: 0, padding: '0 20px 16px' }}>No input reached your models {inRange(label)}.</p>
      ) : (
        <>
          <div className="wr-tokens__totals" role="img" aria-label={`${label.charAt(0).toUpperCase()}${label.slice(1)}: without WhiteRoom about ${fmtTokens(without)} tokens, with WhiteRoom ${fmtTokens(used)} tokens.${fewer ? ` ${fewer}.` : ''}`}>
            <span className="wr-lbl">Without WhiteRoom, est.</span>
            <div className="wr-tokens__track"><div className="wr-tokens__bar wr-tokens__bar--without" style={{ width: 'calc((100% - 72px) * 1)' }} /><strong>{fmtTokens(without)}</strong></div>
            <span className="wr-lbl" style={{ color: 'var(--tx)' }}>With WhiteRoom</span>
            <div className="wr-tokens__track"><div className="wr-tokens__bar wr-tokens__bar--with" style={{ width: `calc((100% - 72px) * ${(used / without).toFixed(3)})` }} /><strong>{fmtTokens(used)}</strong></div>
          </div>
          <p className="wr-cap" style={{ margin: 0, padding: '4px 20px 12px' }}>
            {!fewer && 'Nothing saved in this range. '}The input your agents sent to the models {inRange(label)}, with WhiteRoom and an estimate without it. Includes cached input; output isn’t counted.
            {energy && <> About {energy.replace(/^≈/, '')} less energy, estimated from the tokens saved.</>}
          </p>
        </>
      )}
      {note && <p className="wr-cap" style={{ margin: 0, padding: '0 20px 16px', color: 'var(--warn-tx)' }}>{note}</p>}
      {/* By day is the 7 days: it shows whenever they have calls, even when the picked range has none or couldn't be read. */}
      {max > 0 && (
        <Disclosure label="By day · last 7 days" open={open} onToggle={() => setOpen((v) => !v)} controls={bodyId}>
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
      )}
    </div>
  );
}
