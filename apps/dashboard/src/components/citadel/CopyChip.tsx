'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Icon, FONT_MONO } from '@whiteroom/ui';

/**
 * Copy `text` and show "Copied" for 1.5 s; the timer is cleared on repeat
 * clicks and unmount. `failed`: the browser refused, so the caller can show
 * the text to select instead, until a copy works. `failNote`: the refusal is
 * recent enough to say so (4 s from each failed try).
 */
export function useCopy(text: string): { copied: boolean; failed: boolean; failNote: boolean; copy: () => Promise<void> } {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const [failNote, setFailNote] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    if (noteTimer.current) clearTimeout(noteTimer.current);
  }, []);
  async function copy() {
    if (noteTimer.current) clearTimeout(noteTimer.current);
    setFailNote(false);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setFailed(false);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (permissions, insecure context): the text stays selectable.
      setFailed(true);
      setFailNote(true);
      noteTimer.current = setTimeout(() => setFailNote(false), 4000);
    }
  }
  return { copied, failed, failNote, copy };
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
      <code style={{ fontFamily: FONT_MONO, fontSize: 'var(--fs-sm)', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{display ?? text}</code>
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
