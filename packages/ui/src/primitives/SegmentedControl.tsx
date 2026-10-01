'use client';

import { useRef } from 'react';

export type Segment<V extends string> = {
  value: V;
  label: React.ReactNode;
  /** A 6px status dot before the label, e.g. Enforce or Flagged. */
  dot?: 'warn' | 'ok' | 'brand';
  disabled?: boolean;
  title?: string;
};

/**
 * One-of-N choice for ranges, filters, views and modes. A radiogroup: arrow
 * keys move and select, like native radios; only the selected segment is in
 * the tab order.
 */
export function SegmentedControl<V extends string>({ options, value, onChange, label, size = 26 }: {
  options: Segment<V>[];
  /** null: no segment is on (another control, like a picked day, decides). */
  value: V | null;
  onChange: (v: V) => void;
  /** Accessible name for the group, e.g. "Time range". */
  label: string;
  size?: 24 | 26;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = options.filter((o) => !o.disabled);
  // The tab stop: the selected segment, or the first enabled one when the
  // value isn't a selectable option, so the group is always reachable.
  const tabStop = enabled.some((o) => o.value === value) ? value : enabled[0]?.value;

  function move(from: V, step: 1 | -1) {
    const i = enabled.findIndex((o) => o.value === from);
    const next = enabled[(i + step + enabled.length) % enabled.length];
    if (!next) return;
    onChange(next.value);
    refs.current[options.indexOf(next)]?.focus();
  }

  return (
    <div role="radiogroup" aria-label={label} className="wr-seg">
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={o.value === tabStop ? 0 : -1}
            disabled={o.disabled}
            title={o.title}
            className={`wr-seg__item${on ? ' is-on' : ''}`}
            style={{ height: size }}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); move(o.value, 1); }
              if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); move(o.value, -1); }
            }}
          >
            {o.dot && <span className={`wr-dot wr-dot--${o.dot}`} aria-hidden="true" />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
