'use client';

import type { RunDayCount } from '@/lib/whiteroom/types';
import { dayLabel, localDay } from '@/lib/runs';
import { barHeight, barLabel, tickIndexes } from './strip';

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
    </section>
  );
}
