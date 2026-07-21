'use client';

import { useState } from 'react';

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
        borderColor: copied ? '#3FE0A0' : '#1B2740',
        color: disabled ? '#334155' : copied ? '#3FE0A0' : '#A9B8D4',
        background: copied ? 'rgba(63,224,160,.08)' : 'transparent',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}
