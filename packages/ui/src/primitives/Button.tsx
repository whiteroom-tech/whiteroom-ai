import { forwardRef } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-fill';
export type ButtonSize = 28 | 32 | 36 | 44;

/**
 * Primary (brand fill), secondary (raised), ghost, danger (bad text) and
 * danger-fill (the confirm button in Stop dialogs). `busyLabel` replaces the
 * label and disables the button while `busy`, e.g. "Saving…".
 */
export const Button = forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  busy?: boolean;
  busyLabel?: React.ReactNode;
}>(function Button({ variant = 'secondary', size = 32, busy, busyLabel, className = '', disabled, children, type = 'button', ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`wr-btn wr-btn--${variant} wr-btn--h${size} ${className}`.trim()}
      {...rest}
    >
      {busy && busyLabel ? busyLabel : children}
    </button>
  );
});
