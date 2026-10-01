'use client';

import { FONT_MONO } from '@whiteroom/ui';
import { dayLabel } from '@/lib/runs';

/**
 * Runs per day for the last 30 of the viewer's days, one bar each. Picking a
 * bar shows that day; picking the picked bar again goes back to the range.
 * Bars inside the current range are a step brighter than the rest.
 */
export function DayStrip({ days, selected, inRange, onPick }: {
  days: { day: string; runs: number }[];
  selected: string | null;
  inRange: (day: string) => boolean;
  onPick: (day: string | null) => void;
}) {
  const max = Math.max(1, ...days.map((d) => d.runs));
  return (
    <div>
      <div className="wr-daystrip" role="group" aria-label="Runs per day, last 30 days">
        {days.map((d) => {
          const label = `${dayLabel(d.day)}: ${d.runs} run${d.runs === 1 ? '' : 's'}`;
          const on = d.day === selected;
          return (
            <button
              key={d.day}
              type="button"
              className={`wr-daystrip__day${on ? ' is-selected' : ''}${inRange(d.day) ? ' is-in' : ''}`}
              aria-pressed={on}
              aria-label={label}
              title={label}
              onClick={() => onPick(on ? null : d.day)}
            >
              <span className="wr-daystrip__bar" style={{ height: d.runs ? `${Math.max(14, (d.runs / max) * 100)}%` : 2 }} />
            </button>
          );
        })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontFamily: FONT_MONO, fontSize: 10.5, color: 'var(--tx2)' }}>
        <span>{days[0] ? dayLabel(days[0].day) : ''}</span>
        <span>Today</span>
      </div>
    </div>
  );
}
