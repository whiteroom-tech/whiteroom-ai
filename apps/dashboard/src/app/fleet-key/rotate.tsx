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

  async function run(reissueCloudIdentityKeys: boolean) {
    setBusy(true); setError('');
    try {
      const input = { disconnect: [], reissueCloudIdentityKeys };
      const result = kind === 'api-key' ? await rotateApiKey(input) : await replaceProxyUrls(input);
      if (result.ok) { setCloudKeys(null); onDone(result); return; }
      if (result.cloudIdentityKeys?.length && !reissueCloudIdentityKeys) { setCloudKeys(result.cloudIdentityKeys); return; }
      setError(result.error);
    } catch {
      setError('Couldn’t reach the dashboard. Nothing was changed; try again.');
    } finally {
      setBusy(false);
    }
  }

  const close = () => { setCloudKeys(null); setError(''); onClose(); };
  const title = kind === 'api-key' ? 'Rotate your API key?' : 'Replace every proxy URL?';

  return (
    <>
      <ConfirmDialog
        open={open && !cloudKeys}
        title={title}
        body={<div style={{ display: 'grid', gap: 10 }}>{consequences(kind)}{error && <p role="alert" style={{ margin: 0, color: 'var(--bad)' }}>{error}</p>}</div>}
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
        <div><Button size={28} onClick={onDismiss}>I’ve copied them</Button></div>
      </div>
    </Banner>
  );
}
