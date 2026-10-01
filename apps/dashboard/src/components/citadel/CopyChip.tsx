'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Icon, FONT_MONO } from '@whiteroom/ui';

/** Copy `text` and show "Copied" for 1.5 s; the timer is cleared on repeat clicks and unmount. */
export function useCopy(text: string): { copied: boolean; copy: () => Promise<void> } {
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
  return { copied, copy };
}

/**
 * A line of Mono text with a Copy button that confirms with a tick. `label`
 * names what's copied for screen readers ("Copy the Anthropic setup line");
 * without one, the text itself is used.
 */
export function CopyChip({ text, display, label }: { text: string; display?: React.ReactNode; label?: string }) {
  const { copied, copy } = useCopy(text);
  const name = label ?? `Copy ${text.split('\n')[0]}`;
  return (
    <div className="wr-copy-chip">
      <code style={{ fontFamily: FONT_MONO, fontSize: 12, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{display ?? text}</code>
      <button type="button" onClick={copy} aria-label={name} title="Copy">
        <Icon name={copied ? 'check' : 'copy'} size={13} />
      </button>
      <span className="sr-only" aria-live="polite">{copied ? 'Copied' : ''}</span>
    </div>
  );
}

/**
 * A secondary "Copy" button for a value shown elsewhere (named apart from
 * @whiteroom/ui's CopyButton). `what` completes the accessible name, "Copy your
 * API key", while the visible word stays "Copy" / "Copied".
 */
export function CopyValueButton({ text, what, disabled, title }: { text: string; what: string; disabled?: boolean; title?: string }) {
  const { copied, copy } = useCopy(text);
  return (
    <>
      <Button onClick={copy} disabled={disabled} title={title}>
        {copied ? 'Copied' : 'Copy'}<span className="sr-only"> {what}</span>
      </Button>
      <span className="sr-only" aria-live="polite">{copied ? 'Copied' : ''}</span>
    </>
  );
}
