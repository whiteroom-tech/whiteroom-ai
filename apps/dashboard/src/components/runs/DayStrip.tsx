'use client';

import { useEffect, useRef } from 'react';
import type { RunDayCount } from '@/lib/whiteroom/types';
import { dayLabel, localDay } from '@/lib/runs';
import { barHeight, barLabel, centreBar, tickIndexes } from './strip';

/**
 * Runs per day: a card with 30 of the viewer's days, one bar each, at true
 * heights against the busiest day (its count sits top left). Bars for the
 * days listed below are brand-coloured, the picked day is solid text colour,
 * and flagged runs show as an amber segment at the foot of a bar when the
 * engine counts them. Picking a bar shows that day; picking it again goes back.
 */
export function DayStrip({ days, selected, inRange, onPick, title, legend, flaggedKnown }: {
  days: RunDayCount[];
  selected: string | null;
  inRange: (day: string) => boolean;
  onPick: (day: string | null) => void;
  /** "Runs per day · last 30 days". */
  title: string;
  /** "Last 7 days · 60 runs · select a day to see its hours". */
  legend: string;
  /** The engine sent per-day flagged counts: the amber segment and its key show. */
  flaggedKnown: boolean;
}) {
  // Phones scroll the chart sideways so each bar stays a tappable width. A new window opens on
  // the picked day, else the newest; picking a day centres it; un-picking leaves the strip where it is.
  const first = days[0]?.day;
  const wrap = useRef<HTMLDivElement>(null);
  const shownWindow = useRef<string | undefined>(undefined);
  useEffect(() => {
    const el = wrap.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    const i = selected ? days.findIndex((d) => d.day === selected) : -1;
    const newWindow = shownWindow.current !== first;
    shownWindow.current = first;
    if (i < 0 && !newWindow) return;
    if (i < 0) el.scrollLeft = el.scrollWidth;
    else centreBar(el, i, days.length);
    // Only when the window or the pick changes, never on a poll's re-render, so scrolling back isn't undone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [first, selected, days.length]);
  const max = Math.max(0, ...days.map((d) => d.runs));
  const busiest = days.reduce<RunDayCount | null>((b, d) => (!b || d.runs > b.runs ? d : b), null);
  const today = localDay();
  const ticks = tickIndexes(days.length);
  return (
    <section className="wr-panel wr-runchart" aria-labelledby="runs-per-day">
      <div className="wr-runchart__head">
        <h2 id="runs-per-day" className="wr-panel__title">{title}</h2>
        <span className="wr-runchart__legend">
          <span><span className="wr-runchart__key is-in" aria-hidden="true" />{legend}</span>
          {flaggedKnown && <span><span className="wr-runchart__key is-flag" aria-hidden="true" />Flagged</span>}
        </span>
      </div>
      <div className="wr-strip-scroll" ref={wrap}>
        <div className="wr-runchart__plot">
          {max > 0 && <span className="wr-runchart__max" aria-hidden="true">{max}</span>}
          <div
            className="wr-runchart__bars"
            role="group"
            aria-label={`Runs per day${busiest && max > 0 ? `. Busiest day ${dayLabel(busiest.day, Date.now(), false)} with ${max} runs.` : ''}`}
            style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}
          >
            {days.map((d) => {
              const label = barLabel(dayLabel(d.day), d.runs, { flagged: d.flagged });
              const on = d.day === selected;
              const flagged = flaggedKnown && d.flagged ? Math.min(d.flagged, d.runs) : 0;
              return (
                <button
                  key={d.day}
                  type="button"
                  className={`wr-runchart__day${on ? ' is-selected' : ''}${inRange(d.day) ? ' is-in' : ''}`}
                  aria-pressed={on}
                  aria-label={label}
                  title={label}
                  onClick={() => onPick(on ? null : d.day)}
                >
                  <span className="wr-runchart__bar" style={{ height: barHeight(d.runs, max) }}>
                    {flagged > 0 && <span className="wr-runchart__flag" style={{ height: `max(2px, ${(flagged / d.runs) * 100}%)` }} />}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="wr-runchart__ticks" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
          {ticks.map((i, k) => (
            <span key={days[i].day} style={{ gridColumn: `${i + 1} / span 1`, justifySelf: k === 0 ? 'start' : k === ticks.length - 1 ? 'end' : 'center' }}>
              {days[i].day === today ? 'Today' : dayLabel(days[i].day, Date.now(), false).replace(/^\w+, /, '')}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
