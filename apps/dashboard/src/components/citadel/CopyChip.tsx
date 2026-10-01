'use client';

import { useEffect, useRef, useState } from 'react';
import { Icon, FONT_MONO } from '@whiteroom/ui';

/** A line of Mono text with a Copy button that confirms with a tick. */
export function CopyChip({ text, display }: { text: string; display?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (permissions, insecure context): the text stays selectable.
    }
  }

  return (
    <div className="wr-copy-chip">
      <code style={{ fontFamily: FONT_MONO, fontSize: 12, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{display ?? text}</code>
      <button type="button" onClick={copy} aria-label={copied ? 'Copied' : 'Copy'} title={copied ? 'Copied' : 'Copy'}>
        <Icon name={copied ? 'check' : 'copy'} size={13} />
      </button>
    </div>
  );
}
