'use client';

// The range menu Runs and Performance share, so the two can't drift:
// Today · 7 days · 30 days · Custom, in the viewer's calendar days
// (lib/runs: runsDays, runsWindow), and a custom range's From / to pickers.
import { SegmentedControl } from '@whiteroom/ui';
import { RUNS_RANGES, validDay, type RunsRange } from '@/lib/runs';

export const RANGE_LABEL: Record<RunsRange, string> = { today: 'Today', '7d': '7 days', '30d': '30 days', custom: 'Custom' };

/** Today · 7 days · 30 days · Custom. `value` null: none is on (a picked day decides). `unavailable` ones show but can't be picked. */
export function RangeMenu({ value, onChange, unavailable = [], unavailableTitle }: {
  value: RunsRange | null;
  onChange: (r: RunsRange) => void;
  unavailable?: RunsRange[];
  /** Why the unavailable ones can't be picked (their tooltip). */
  unavailableTitle?: string;
}) {
  return (
    <SegmentedControl<RunsRange>
      label="Time range"
      value={value}
      onChange={onChange}
      size={26}
      options={RUNS_RANGES.map((r) => ({ value: r, label: RANGE_LABEL[r], ...(unavailable.includes(r) ? { disabled: true, title: unavailableTitle } : {}) }))}
    />
  );
}

/** A custom range's From and to day pickers, bounded by what the plan keeps (`oldest`) and today. */
export function RangeDates({ idPrefix, fromDay, toDay, oldest, today, maxDays, onFrom, onTo }: {
  /** "runs": the inputs are #runs-from and #runs-to. */
  idPrefix: string;
  fromDay: string;
  toDay: string;
  oldest: string | null;
  today: string;
  /** The longest range one pick can be, for the tooltip. */
  maxDays: number;
  onFrom: (day: string) => void;
  onTo: (day: string) => void;
}) {
  return (
    <span className="wr-runs-filters__dates" title={`Up to ${maxDays} days at a time`}>
      <label htmlFor={`${idPrefix}-from`}>From</label>
      <input id={`${idPrefix}-from`} type="date" className="wr-date" value={fromDay} min={oldest ?? undefined} max={today} onChange={(e) => { if (validDay(e.target.value)) onFrom(e.target.value); }} />
      <label htmlFor={`${idPrefix}-to`}>to</label>
      <input id={`${idPrefix}-to`} type="date" className="wr-date" value={toDay} min={oldest ?? undefined} max={today} onChange={(e) => { if (validDay(e.target.value)) onTo(e.target.value); }} />
    </span>
  );
}
