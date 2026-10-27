'use client';

import { Button } from '@whiteroom/ui';
import type { RunHourCount } from '@/lib/whiteroom/types';
import { hourLabel } from '@/lib/runs';
import { barHeight, barLabel } from './strip';

const TICKS = [0, 3, 6, 9, 12, 15, 18, 21];

/**
 * A picked day's runs per hour: a card with 24 bars, each hour's count above
 * its bar and an amber cap on hours with rule activity (when the engine counts
 * it). Picking a bar lists that hour's runs; picking it again, or All hours,
 * goes back to the whole day. Back to 30 days drops the day.
 */
export function HourStrip({ dayName, hours, selected, onPick, onBack }: {
  dayName: string;
  hours: RunHourCount[];
  selected: number | null;
  /** Absent when the engine can't list one hour's runs: the bars then only show counts. */
  onPick?: (hour: number | null) => void;
  onBack: () => void;
}) {
  const byHour = new Map(hours.map((h) => [h.hour, h]));
  const max = Math.max(1, ...hours.map((h) => h.runs));
  const ruleKnown = hours.some((h) => h.ruleActivity !== undefined);
  const hasRuns = hours.some((h) => h.runs > 0);
  return (
    <section className="wr-panel wr-runchart" aria-labelledby="runs-by-hour">
      <div className="wr-runchart__head">
        <h2 id="runs-by-hour" className="wr-panel__title">{dayName} by hour</h2>
        <span className="wr-runchart__actions">
          {selected !== null && onPick && (
            <>
              <span className="wr-runchart__note">Showing {hourLabel(selected)}–{hourLabel((selected + 1) % 24)}</span>
              <Button size={32} onClick={() => onPick(null)}>All hours</Button>
            </>
          )}
          <Button size={32} onClick={onBack}>Back to 30 days</Button>
        </span>
      </div>
      {!hasRuns ? (
        <p className="wr-runchart__note" style={{ margin: 0 }}>No runs that day.</p>
      ) : (
        <>
          <div>
              <div className="wr-runchart__bars is-hours" role="group" aria-label={`Runs per hour on ${dayName}`}>
                {Array.from({ length: 24 }, (_, h) => {
                  const c = byHour.get(h);
                  const n = c?.runs ?? 0;
                  const rule = !!c?.ruleActivity;
                  const on = h === selected;
                  const label = barLabel(hourLabel(h), n, { ruleActivity: c?.ruleActivity });
                  return (
                    <button key={h} type="button" className={`wr-runchart__day is-in${on ? ' is-selected' : ''}`}
                      aria-pressed={on} aria-label={label} title={label} disabled={!onPick || (n === 0 && !on)} onClick={() => onPick?.(on ? null : h)}>
                      {n > 0 && <span className="wr-runchart__count">{n}</span>}
                      <span className={`wr-runchart__bar${rule ? ' has-rule' : ''}`} style={{ height: n ? `max(4px, ${((n / max) * 72).toFixed(1)}%)` : barHeight(0, max) }} />
                    </button>
                  );
                })}
              </div>
              <div aria-hidden className="wr-runchart__hticks">
                {TICKS.map((h) => <span key={h}>{hourLabel(h)}</span>)}
              </div>
          </div>
          <p className="wr-runchart__legend is-foot">
            <span><span className="wr-runchart__key is-in" aria-hidden="true" />Runs started that hour</span>
            {ruleKnown && <span><span className="wr-runchart__key is-rule" aria-hidden="true" />Hour with rule activity</span>}
            {onPick && <span>Select an hour to see its runs</span>}
          </p>
        </>
      )}
    </section>
  );
}
