'use client';

import { useRef, useState } from 'react';
import { Button } from '@whiteroom/ui';
import { connectCheck, type ConnectRefusal } from '@/lib/sandbox/fleet';
import { detectKey, isCloudProvider, KEY_HELP, type SandboxProvider } from '@/lib/sandbox/providers';
import { CloudEndpointField, ProviderChoices } from '../CloudProviderParts';
import s from '../guided.module.css';
import v from './v2.module.css';

const KEY_PLACEHOLDER: Record<SandboxProvider, string> = {
  anthropic: 'sk-ant-…',
  openai: 'sk-…',
  'azure-openai': 'Your Azure OpenAI key',
  foundry: 'Your Foundry key',
  'bedrock-mantle': 'Your Bedrock API key',
};

export type ConnectRequest = { api_key: string; provider: SandboxProvider; endpoint?: string };

/**
 * Connect (first-run UX spec §7.1): the key first. An Anthropic (sk-ant-) or
 * OpenAI (sk-) key says its own provider; Azure, Foundry and Bedrock are behind
 * one link, and a key that's neither opens the choices too. The key stays in
 * this form only until Connect sends it; it's cleared after, either way.
 */
export function ConnectForm({ busy, onConnect, onRefused, onCancel }: {
  busy: boolean;
  /** Resolves to the refusal to show, or null when it connected. `detected`: the provider came from the key. */
  onConnect: (req: ConnectRequest, detected: boolean) => Promise<string | null>;
  /** Refused in the browser, before anything was sent: why, as a category. */
  onRefused?: (reason: ConnectRefusal) => void;
  onCancel?: () => void;
}) {
  // Picked from the choices; null while the key decides.
  const [picked, setPicked] = useState<SandboxProvider | null>(null);
  // The choices are open: by the cloud link, or a key that isn't Anthropic's or OpenAI's. Once open, or
  // once something is picked, they stay: a pick must never drive Connect while hidden.
  const [choosing, setChoosing] = useState(false);
  const [key, setKey] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  // Set synchronously, so a double click can't send two connects.
  const inFlight = useRef(false);

  const kind = detectKey(key);
  const fromKey = kind === 'anthropic' || kind === 'openai' ? kind : null;
  const provider = picked ?? fromKey;
  const showChoices = choosing || kind === 'unknown';

  async function submit() {
    if (inFlight.current || busy) return;
    if (!provider && kind !== 'empty' && kind !== 'fleet' && kind !== 'account') { setChoosing(true); setError('Pick where your agent’s model runs.'); onRefused?.('no_provider'); return; }
    const check = connectCheck(provider ?? 'anthropic', key, endpoint);
    if (!check.ok) { setError(check.error); onRefused?.(check.reason); return; }
    inFlight.current = true;
    setError('');
    try {
      const refused = await onConnect(check.request, picked === null);
      setKey('');
      if (refused) setError(refused);
    } finally {
      inFlight.current = false;
    }
  }

  const cloud = !!provider && isCloudProvider(provider);
  const hint = error ? null
    : kind === 'fleet' || kind === 'account' ? <span style={{ color: 'var(--bad)' }}>That’s a WhiteRoom key. Paste the key your agent uses with its provider.</span>
    : picked === null && fromKey ? <span style={{ color: 'var(--ok)' }}>{fromKey === 'anthropic' ? 'Anthropic' : 'OpenAI'} key. We keep only the last 4 characters.</span>
    : kind === 'unknown' && !picked ? <>Pick where your agent’s model runs, below. We keep only the last 4 characters.</>
    : <>The key your agent already uses. We keep only the last 4 characters.{picked && !isCloudProvider(picked) && <> {KEY_HELP[picked]}</>}</>;
  return (
    <form className={v.stack} onSubmit={(e) => { e.preventDefault(); void submit(); }} aria-label="Connect your provider key">
      <div className={s.formGroup} style={{ marginBottom: 0 }}>
        <label className={s.formLabel} htmlFor="sandbox-v2-key">API key</label>
        <div className={s.keyWrap}>
          <input
            id="sandbox-v2-key"
            className={s.formInput}
            type={show ? 'text' : 'password'}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="none"
            readOnly={busy}
            value={key}
            onChange={(e) => { setKey(e.target.value); setError(''); }}
            placeholder={picked ? KEY_PLACEHOLDER[picked] : 'sk-ant-… or sk-…'}
            aria-invalid={error ? true : undefined}
            aria-describedby="sandbox-v2-key-hint"
          />
          <button type="button" className={s.keyShow} onClick={() => setShow((x) => !x)}>{show ? 'Hide' : 'Show'}</button>
        </div>
        <p id="sandbox-v2-key-hint" className={s.small} style={{ marginTop: 6 }} aria-live="polite">
          {error ? <span role="alert" style={{ color: 'var(--bad)' }}>{error}</span> : hint}
        </p>
      </div>
      {showChoices ? <>
        <ProviderChoices value={provider} unsupported={[]} disabled={busy} onPick={(p) => { setPicked(p); setChoosing(true); setError(''); }} />
        {cloud && provider && (
          <CloudEndpointField provider={provider} value={endpoint} error="" keyNote="" onChange={setEndpoint} onSubmit={() => void submit()} />
        )}
      </> : (
        <button type="button" className={v.linkButton} onClick={() => setChoosing(true)} disabled={busy}>Using Azure, Foundry or Bedrock?</button>
      )}
      <div className={v.actions}>
        <Button type="submit" variant="primary" size={36} busy={busy} busyLabel="Connecting…">Connect</Button>
        {onCancel && <Button variant="ghost" size={36} onClick={onCancel} disabled={busy}>Cancel</Button>}
      </div>
    </form>
  );
}
