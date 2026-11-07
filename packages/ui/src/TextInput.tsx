import { forwardRef } from 'react';
import { FONT_MONO, color } from './theme';

/** Styled single-line text input — value + onChange(value), controlled.
 *  Pass onCommit for fields that should only save on an explicit action
 *  (Enter key or blur) rather than on every keystroke — e.g. a label that
 *  keys a backend record, where saving mid-type would create one record
 *  per partial value typed. `invalid` marks it (red border, aria-invalid)
 *  and `describedBy` names the note that says why. */
export const TextInput = forwardRef<HTMLInputElement, {
  value: string;
  onChange: (v: string) => void;
  onCommit?: (v: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
  mono?: boolean;
  invalid?: boolean;
  describedBy?: string;
}>(function TextInput({
  value,
  onChange,
  onCommit,
  placeholder,
  ariaLabel,
  className,
  mono,
  invalid,
  describedBy,
}, ref) {
  return (
    <input
      ref={ref}
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onCommit ? (e) => { if (e.key === 'Enter') onCommit(e.currentTarget.value); } : undefined}
      onBlur={onCommit ? (e) => onCommit(e.currentTarget.value) : undefined}
      placeholder={placeholder}
      className={className}
      style={{
        background: color.sunk,
        border: `1px solid ${invalid ? color.bad : color.line}`,
        color: color.tx,
        borderRadius: 6,
        padding: '4px 8px',
        fontSize: 'var(--fs-sm, 0.96875rem)',
        fontFamily: mono ? FONT_MONO : undefined,
      }}
    />
  );
});
