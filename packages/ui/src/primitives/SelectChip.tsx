import { Icon } from './icons';

/** A native <select> dressed as a chip ("All agents ▾"), so keyboard and screen readers get the real control. */
export function SelectChip<V extends string>({ value, onChange, options, label, height = 28 }: {
  value: V;
  onChange: (v: V) => void;
  options: { value: V; label: string }[];
  /** Accessible name, e.g. "Agent". */
  label: string;
  height?: 28 | 30;
}) {
  return (
    <span className="wr-select" style={{ height }}>
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value as V)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <Icon name="chevronDown" size={10} strokeWidth={2.5} />
    </span>
  );
}
