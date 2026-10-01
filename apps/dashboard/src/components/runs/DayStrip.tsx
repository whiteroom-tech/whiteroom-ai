'use client';

import { Button, FONT_MONO } from '@whiteroom/ui';
import { dayLabel, localDay } from '@/lib/runs';

/**
 * Runs per day for 30 of the viewer's days, one bar each, with ‹ › to page
 * 30 days back or forward. Picking a bar shows that day; picking the picked
 * bar again goes back to the range. Bars inside the shown days are a step
 * brighter than the rest.
 */
export function DayStrip({ days, selected, inRange, onPick, onEarlier, onLater }: {
  days: { day: string; runs: number }[];
  selected: string | null;
  inRange: (day: string) => boolean;
  onPick: (day: string | null) => void;
  /** Absent when there's nothing earlier the plan keeps. */
  onEarlier?: () => void;
  /** Absent when the strip already ends today. */
  onLater?: () => void;
}) {
  const first = days[0]?.day;
  const last = days[days.length - 1]?.day;
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, fontFamily: FONT_MONO, fontSize: 10.5, color: 'var(--tx2)' }}>
        <Button variant="ghost" size={28} aria-label="Earlier 30 days" disabled={!onEarlier} onClick={onEarlier}>&lsaquo;</Button>
        <span>{first ? dayLabel(first, Date.now(), false) : ''}</span>
        <span style={{ marginLeft: 'auto' }}>{last ? (last === localDay() ? 'Today' : dayLabel(last, Date.now(), false)) : ''}</span>
        <Button variant="ghost" size={28} aria-label="Later 30 days" disabled={!onLater} onClick={onLater}>&rsaquo;</Button>
      </div>
    </div>
  );
}
