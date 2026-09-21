import { FONT_MONO } from './theme';

/** Styled single-line text input — value + onChange(value), controlled.
 *  Pass onCommit for fields that should only save on an explicit action
 *  (Enter key or blur) rather than on every keystroke — e.g. a label that
 *  keys a backend record, where saving mid-type would create one record
 *  per partial value typed. */
export function TextInput({
  value,
  onChange,
  onCommit,
  placeholder,
  ariaLabel,
  className,
  mono,
}: {
  value: string;
  onChange: (v: string) => void;
  onCommit?: (v: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
  mono?: boolean;
}) {
  return (
    <input
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onCommit ? (e) => { if (e.key === 'Enter') onCommit(e.currentTarget.value); } : undefined}
      onBlur={onCommit ? (e) => onCommit(e.currentTarget.value) : undefined}
      placeholder={placeholder}
      className={className}
      style={{
        background: 'var(--sunk, #050810)',
        border: '1px solid var(--line, #1e293b)',
        color: 'var(--tx, #e2e8f0)',
        borderRadius: 6,
        padding: '4px 8px',
        fontSize: 11,
        fontFamily: mono ? FONT_MONO : undefined,
      }}
    />
  );
}
