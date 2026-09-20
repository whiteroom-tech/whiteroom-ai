import { FONT_MONO } from './theme';

/** Styled single-line text input — value + onChange(value), controlled. */
export function TextInput({
  value,
  onChange,
  placeholder,
  ariaLabel,
  className,
  mono,
}: {
  value: string;
  onChange: (v: string) => void;
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
