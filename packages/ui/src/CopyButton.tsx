'use client';

import { useState } from 'react';
import { color } from './theme';

/** Copy-to-clipboard button with a transient "Copied" confirmation. */
export function CopyButton({ text, disabled }: { text: string; disabled?: boolean }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      disabled={disabled}
      onClick={() => {
        if (disabled) return;
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
      className="ml-2 shrink-0 px-3 py-1.5 text-xs font-mono rounded-md border transition-all"
      style={{
        borderColor: copied ? color.ok : color.line,
        color: disabled ? color.tx2 : copied ? color.ok : color.tx2,
        background: copied ? 'var(--ok-bg)' : 'transparent',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}
