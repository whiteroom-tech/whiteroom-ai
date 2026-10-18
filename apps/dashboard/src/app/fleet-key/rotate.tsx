'use client';

// The owner's remedies for a leaked credential (P0 #1): rotate the API key, or
// replace the proxy URLs alone. Both confirm first and say exactly what stops
// working; keys on the engine's cloud identity need a second, separate yes.
// New values are shown once.

import { useState } from 'react';
import { Banner, Button } from '@whiteroom/ui';
import { ConfirmDialog } from '@/components/citadel/ConfirmDialog';
import { CopyChip } from '@/components/citadel/CopyChip';
import { PROVIDER_LABELS, issuedEnvHint } from '@/lib/provider-key-form';
import { PROXY_ORIGIN } from '@/lib/setup';
import { replaceProxyUrls, rotateApiKey, type CredentialChange, type CredentialKey } from '@/lib/owner-credentials';

export type RotationKind = 'api-key' | 'proxy-urls';

/** One confirmation: runs the change and says what the dialog does next. */
export async function attempt(
  kind: RotationKind,
  reissueCloudIdentityKeys: boolean,
  actions: { rotateApiKey: typeof rotateApiKey; replaceProxyUrls: typeof replaceProxyUrls } = { rotateApiKey, replaceProxyUrls },
): Promise<ReturnType<typeof nextStep>> {
  const input = { disconnect: [], reissueCloudIdentityKeys };
  const result = kind === 'api-key' ? await actions.rotateApiKey(input) : await actions.replaceProxyUrls(input);
  return nextStep(result, reissueCloudIdentityKeys);
}

/** What the dialog does with an answer: finish, ask for cloud-identity consent, or show the error. */
export function nextStep(result: CredentialChange, consented: boolean):
  | { step: 'done'; result: Extract<CredentialChange, { ok: true }> }
  | { step: 'consent'; keys: CredentialKey[] }
  | { step: 'error'; error: string; unconfirmedApiKey?: string } {
  if (result.ok) return { step: 'done', result };
  if (result.cloudIdentityKeys?.length && !consented) return { step: 'consent', keys: result.cloudIdentityKeys };
  return { step: 'error', error: result.error, ...(result.unconfirmedApiKey && { unconfirmedApiKey: result.unconfirmedApiKey }) };
}

const label = (k: CredentialKey) => `${PROVIDER_LABELS[k.provider] ?? k.provider} key ending ${k.keyHint}`;

/** What stops working, for the confirmation. */
function consequences(kind: RotationKind) {
  return kind === 'api-key' ? (
    <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>
      <li>You get a new API key. The current one stops working at once, for the CLI and every agent using it.</li>
      <li>Every proxy URL is replaced with a new one. Agents on the old URLs fail until you update them.</li>
      <li>Other WhiteRoom accounts that linked this fleet lose access. A Bedrock role connection is removed and has to be set up again.</li>
    </ul>
  ) : (
    <p style={{ margin: 0 }}>Every proxy URL is replaced with a new one, with the same provider key behind it. Agents on the old URLs fail until you update them. Your API key stays the same.</p>
  );
}

export function RotateDialog({ kind, open, onClose, onDone }: {
  kind: RotationKind;
  open: boolean;
  onClose: () => void;
  /** The change went through: the new API key (on a rotation) and the new proxy URLs, to show once. */
  onDone: (result: Extract<CredentialChange, { ok: true }>) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cloudKeys, setCloudKeys] = useState<CredentialKey[] | null>(null);
  // Outcome unknown: the possibly-new key, kept on screen until the dialog closes.
  const [unconfirmedKey, setUnconfirmedKey] = useState<string | null>(null);

  async function run(reissueCloudIdentityKeys: boolean) {
    setBusy(true); setError('');
    try {
      const next = await attempt(kind, reissueCloudIdentityKeys);
      if (next.step === 'done') { setCloudKeys(null); onDone(next.result); return; }
      if (next.step === 'consent') { setCloudKeys(next.keys); return; }
      setError(next.error);
      if (next.unconfirmedApiKey) setUnconfirmedKey(next.unconfirmedApiKey);
    } catch {
      setError('Couldn’t reach the dashboard. Nothing was changed; try again.');
    } finally {
      setBusy(false);
    }
  }

  const close = () => { setCloudKeys(null); setError(''); setUnconfirmedKey(null); onClose(); };
  const title = kind === 'api-key' ? 'Rotate your API key?' : 'Replace every proxy URL?';

  return (
    <>
      <ConfirmDialog
        open={open && !cloudKeys}
        title={title}
        body={
          <div style={{ display: 'grid', gap: 10 }}>
            {consequences(kind)}
            {error && <p role="alert" style={{ margin: 0, color: 'var(--bad)' }}>{error}</p>}
            {unconfirmedKey && <CopyChip text={unconfirmedKey} display="Possibly new API key (hidden)" label="Copy the possibly new API key" />}
          </div>
        }
        confirmLabel={kind === 'api-key' ? 'Rotate API key' : 'Replace URLs'}
        busy={busy}
        onConfirm={() => void run(false)}
        onCancel={close}
      />
      <ConfirmDialog
        open={open && !!cloudKeys}
        title="Reissue keys that spend on WhiteRoom’s cloud account?"
        body={
          <div style={{ display: 'grid', gap: 10 }}>
            <p style={{ margin: 0 }}>These keys call your model through WhiteRoom’s own cloud identity, so anyone holding one spends on that account. New ones are issued only if you confirm here.</p>
            <ul style={{ margin: 0, paddingLeft: 18 }}>{cloudKeys?.map((k) => <li key={k.prefix}>{label(k)}</li>)}</ul>
            {error && <p role="alert" style={{ margin: 0, color: 'var(--bad)' }}>{error}</p>}
          </div>
        }
        confirmLabel="Reissue them too"
        busy={busy}
        onConfirm={() => void run(true)}
        onCancel={close}
      />
    </>
  );
}

/** The new credentials, shown once. */
export function RotationResult({ result, onDismiss }: { result: Extract<CredentialChange, { ok: true }>; onDismiss: () => void }) {
  return (
    <Banner variant="info" icon="check">
      <div style={{ display: 'grid', gap: 8 }}>
        <span>
          {result.apiKey ? 'Your API key is rotated. ' : 'Your proxy URLs are replaced. '}
          These are shown once, so copy them now and update your agents.
        </span>
        {result.notSaved && <strong>Your new key couldn’t be saved to your account, so this is the only copy. Copy it before you leave this page.</strong>}
        {result.apiKey && <CopyChip text={result.apiKey} display="New API key (hidden)" label="Copy the new API key" />}
        {result.proxyKeys.map((k) => k.wrKey && (
          <div key={k.wrKey.slice(0, 22)} style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 12.5 }}>{label(k)}{k.endpoint ? ` · ${k.endpoint}` : ''}</span>
            <CopyChip text={`${PROXY_ORIGIN}/${k.wrKey}`} label={`Copy the new proxy URL for the ${label(k)}`} />
            <CopyChip text={issuedEnvHint(k.provider, `${PROXY_ORIGIN}/${k.wrKey}`)} label={`Copy the environment line for the ${label(k)}`} />
          </div>
        ))}
        {result.proxyKeysLost && <span>The new proxy URLs couldn’t be shown. Replace the URLs again to get new ones.</span>}
        {result.disconnected.length > 0 && <span>Disconnected: {result.disconnected.map(label).join(', ')}.</span>}
        {/* Unsaved, a reload would bring back the old, dead key: the banner stays. */}
        {!result.notSaved && <div><Button size={28} onClick={onDismiss}>I’ve copied them</Button></div>}
      </div>
    </Banner>
  );
}
