'use client';

import { useRef, useState } from 'react';
import { Button } from '@whiteroom/ui';
import { connectCheck } from '@/lib/sandbox/fleet';
import { isCloudProvider, KEY_HELP, type SandboxProvider } from '@/lib/sandbox/providers';
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
 * Connect: where the agent's model runs, and the key it uses. The key stays in
 * this form only until Connect sends it; it's cleared after, either way.
 */
export function ConnectForm({ busy, onConnect, onCancel }: {
  busy: boolean;
  /** Resolves to the refusal to show, or null when it connected. */
  onConnect: (req: ConnectRequest) => Promise<string | null>;
  onCancel?: () => void;
}) {
  const [provider, setProvider] = useState<SandboxProvider>('anthropic');
  const [key, setKey] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  // Set synchronously, so a double click can't send two connects.
  const inFlight = useRef(false);

  async function submit() {
    if (inFlight.current || busy) return;
    const check = connectCheck(provider, key, endpoint);
    if (!check.ok) { setError(check.error); return; }
    inFlight.current = true;
    setError('');
    try {
      const refused = await onConnect(check.request);
      setKey('');
      if (refused) setError(refused);
    } finally {
      inFlight.current = false;
    }
  }

  const cloud = isCloudProvider(provider);
  return (
    <form className={v.stack} onSubmit={(e) => { e.preventDefault(); void submit(); }} aria-label="Connect your provider key">
      <ProviderChoices value={provider} unsupported={[]} disabled={busy} onPick={(p) => { setProvider(p); setError(''); }} />
      {cloud && (
        <CloudEndpointField provider={provider} value={endpoint} error="" keyNote="" onChange={setEndpoint} onSubmit={() => void submit()} />
      )}
      <div className={s.formGroup} style={{ marginBottom: 0 }}>
        <label className={s.formLabel} htmlFor="sandbox-v2-key">Your agent’s provider key</label>
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
            placeholder={KEY_PLACEHOLDER[provider]}
            aria-invalid={error ? true : undefined}
            aria-describedby="sandbox-v2-key-hint"
          />
          <button type="button" className={s.keyShow} onClick={() => setShow((x) => !x)}>{show ? 'Hide' : 'Show'}</button>
        </div>
        <p id="sandbox-v2-key-hint" className={s.small} style={{ marginTop: 6 }} aria-live="polite">
          {error
            ? <span role="alert" style={{ color: 'var(--bad)' }}>{error}</span>
            : <>Paste the key your agent uses. We keep only its last 4 characters.{!cloud && <> {KEY_HELP[provider]}</>}</>}
        </p>
      </div>
      <div className={v.actions}>
        <Button type="submit" variant="primary" size={36} busy={busy} busyLabel="Connecting…">Connect</Button>
        {onCancel && <Button variant="ghost" size={36} onClick={onCancel} disabled={busy}>Cancel</Button>}
      </div>
    </form>
  );
}
