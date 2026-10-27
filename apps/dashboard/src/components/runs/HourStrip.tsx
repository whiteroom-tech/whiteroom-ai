'use client';

import { useEffect, useRef } from 'react';
import { FONT_MONO } from '@whiteroom/ui';
import { hourLabel } from '@/lib/runs';

/**
 * A picked day's runs per hour: 24 bars. Picking a bar lists that hour's
 * runs; picking it again, or All hours, goes back to the whole day.
 */
export function HourStrip({ dayName, hours, selected, onPick }: {
  dayName: string;
  hours: { hour: number; runs: number }[];
  selected: number | null;
  onPick: (hour: number | null) => void;
}) {
  const byHour = new Map(hours.map((h) => [h.hour, h.runs]));
  const max = Math.max(1, ...hours.map((h) => h.runs));
  // Where the strip scrolls (phones), open on the busiest hour rather than midnight.
  const wrap = useRef<HTMLDivElement>(null);
  const busiest = hours.reduce<{ hour: number; runs: number } | null>((b, h) => (!b || h.runs > b.runs ? h : b), null)?.hour ?? null;
  useEffect(() => {
    const el = wrap.current;
    if (!el || busiest === null || el.scrollWidth <= el.clientWidth) return;
    el.scrollLeft = Math.max(0, (busiest / 24) * el.scrollWidth - el.clientWidth / 2);
  }, [busiest, dayName]);
  return (
    <section aria-label={`${dayName} by hour`} style={{ display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: 'var(--fs-md)', fontWeight: 600 }}>{dayName} by hour</h3>
        {selected !== null && (
          <button type="button" onClick={() => onPick(null)} style={{ padding: 0, border: 0, background: 'none', color: 'var(--brand)', fontWeight: 600, fontSize: 'var(--fs-sm)', cursor: 'pointer' }}>All hours</button>
        )}
      </div>
      {/* Phones scroll the hours sideways in here, so every bar stays tappable. */}
      <div className="wr-hourstrip-wrap" ref={wrap}>
      <div className="wr-daystrip wr-hourstrip" role="group" aria-label={`Runs per hour, ${dayName}`}>
        {Array.from({ length: 24 }, (_, h) => {
          const n = byHour.get(h) ?? 0;
          const on = h === selected;
          const label = `${hourLabel(h)}: ${n} run${n === 1 ? '' : 's'}`;
          return (
            <button key={h} type="button" className={`wr-daystrip__day${on ? ' is-selected' : ''}${selected === null ? ' is-in' : ''}`}
              aria-pressed={on} aria-label={label} title={label} disabled={n === 0 && !on} onClick={() => onPick(on ? null : h)}>
              <span className="wr-daystrip__bar" style={{ height: n ? `${Math.max(14, (n / max) * 100)}%` : 2 }} />
            </button>
          );
        })}
      </div>
      <div aria-hidden className="wr-hourstrip-axis" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', marginTop: 4, fontFamily: FONT_MONO, fontSize: 'var(--fs-xs)', color: 'var(--tx2)' }}>
        {[0, 6, 12, 18].map((h) => <span key={h}>{hourLabel(h)}</span>)}
      </div>
      </div>
    </section>
  );
}
