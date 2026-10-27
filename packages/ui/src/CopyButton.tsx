'use client';

import { useState } from 'react';
import { color } from './theme';

/**
 * Copy-to-clipboard button with a transient "Copied" confirmation. `label`
 * names what it copies for screen readers ("Copy run code") when the visible
 * "Copy" alone wouldn't say.
 */
export function CopyButton({ text, disabled, label }: { text: string; disabled?: boolean; label?: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      disabled={disabled}
      aria-label={label && !copied ? label : undefined}
      onClick={() => {
        if (disabled) return;
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
      className="ml-2 shrink-0 px-3 py-1.5 rounded-md border transition-all"
      style={{
        fontSize: 'var(--fs-sm, 0.96875rem)',
        borderColor: copied ? color.ok : color.line,
        color: copied ? color.ok : color.tx2,
        background: copied ? 'var(--ok-bg)' : 'transparent',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}
