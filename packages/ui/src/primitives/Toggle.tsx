/** 32×18 switch. A real button with role="switch", so it's keyboard-operable. */
export function Toggle({ checked, onChange, label, disabled, title }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  /** Accessible name, e.g. "Email alerts for m.reyes@acme.com". */
  label: string;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      disabled={disabled}
      className={`wr-toggle${checked ? ' is-on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="wr-toggle__knob" aria-hidden="true" />
    </button>
  );
}
