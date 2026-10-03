'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { setByok } from '@/lib/users';
import { azureOpenAIEndpoint } from '@/lib/azure-endpoint';
import { deleteProviderKey, listProviderKeys, storeProviderKey } from '@/lib/whiteroom/client';
import type { FleetAuth } from '@/lib/whiteroom/client';
import type { ProviderKey } from '@/lib/whiteroom/types';
import { Banner, Button, Panel, SegmentedControl, FONT_MONO } from '@whiteroom/ui';
import { PageHeader } from '@/components/citadel/PageChrome';
import { ConfirmDialog } from '@/components/citadel/ConfirmDialog';
import { CopyChip, CopyValueButton } from '@/components/citadel/CopyChip';
import { ROUTES } from '@/lib/routes';
import { PROXY_ORIGIN, SETUP_GUIDE_URL, SETUP_LINES } from '@/lib/setup';
import { fmtDay } from '@/lib/format';

interface Props {
  name: string;
  email: string;
  apiKey: string;
  fleetId: string;
  fleetToken: string | null;
  isNew: boolean;
}

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  azure: 'Azure OpenAI',
  'azure-openai': 'Azure OpenAI',
};

type ProviderTab = 'direct' | 'azure' | 'aws';

// BYOK: one account can connect several provider keys at once. The engine
// keeps them per fleet as a list and issues each key its own proxy URL, so an
// Anthropic key and an OpenAI key (or two Anthropic keys for different
// projects) sit side by side rather than one replacing the other. Only a hash
// and the last four characters are stored — the raw key never leaves the
// customer's control except as a per-request forward to the provider.
function ByokCard({ apiKey, fleetId, fleetToken, tab, previewKeys }: {
  apiKey: string; fleetId: string; fleetToken: string | null; tab: ProviderTab;
  /** /dev/fleet-key: sample keys, and nothing is fetched or changed. */
  previewKeys?: ProviderKey[];
}) {
  const auth = useMemo<FleetAuth>(() => ({ apiKey, fleetId, fleetToken }), [apiKey, fleetId, fleetToken]);
  const [keys, setKeys] = useState<ProviderKey[] | null>(previewKeys ?? null);
  const [value, setValue] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'error'>('idle');
  const [msg, setMsg] = useState('');
  const [issued, setIssued] = useState<{ proxyUrl: string; keyHint: string; provider: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ProviderKey | null>(null);

  const refresh = useCallback(async (): Promise<ProviderKey[]> => {
    const res = await listProviderKeys(auth);
    const list = res.keys ?? [];
    setKeys(list);
    return list;
  }, [auth]);

  useEffect(() => {
    if (previewKeys) return;
    refresh().catch(() => setKeys([]));
  }, [refresh, previewKeys]);

  const isAzure = tab === 'azure';

  async function connect(): Promise<boolean> {
    if (previewKeys) return false;
    const key = value.trim();
    if (isAzure) {
      if (key.length < 12) {
        setStatus('error');
        setMsg('Enter your Azure API key (from the Azure portal → Keys and Endpoint).');
        return false;
      }
      const ep = endpoint.trim();
      if (!ep) {
        setStatus('error');
        setMsg('Enter your Azure endpoint URL (e.g. https://myresource.openai.azure.com).');
        return false;
      }
      if (!azureOpenAIEndpoint(ep)) {
        setStatus('error');
        setMsg('Endpoint must be your Azure resource URL (e.g. https://myresource.openai.azure.com).');
        return false;
      }
    } else {
      if (!/^sk-/.test(key) || key.length < 12) {
        setStatus('error');
        setMsg('That does not look like a provider API key (sk-ant-… for Anthropic, sk-… for OpenAI).');
        return false;
      }
    }
    setStatus('saving'); setMsg('');
    try {
      const result = isAzure
        ? await storeProviderKey(auth, key, azureOpenAIEndpoint(endpoint) ?? undefined, 'azure-openai')
        : await storeProviderKey(auth, key);
      if (!result.success || !result.proxyUrl) {
        setStatus('error'); setMsg(result.error || 'Could not connect that key.'); return false;
      }
      const provider = result.provider ?? (isAzure ? 'azure-openai' : key.startsWith('sk-ant-') ? 'anthropic' : 'openai');
      setIssued({ proxyUrl: result.proxyUrl, keyHint: result.keyHint ?? key.slice(-4), provider });
      setValue(''); setEndpoint(''); setStatus('idle');
      await refresh();
      await setByok(true);
      return true;
    } catch (e) {
      setStatus('error'); setMsg(e instanceof Error ? e.message : 'Network error.');
      return false;
    }
  }

  async function disconnect(k: ProviderKey) {
    if (previewKeys) return;
    const prefix = k.wrKey.replace(/\.+$/, '');
    setStatus('saving'); setMsg('');
    try {
      const result = await deleteProviderKey(auth, prefix);
      if (!result.success) {
        setStatus('error'); setMsg(result.error || 'Could not remove that key.'); return;
      }
      if (issued?.proxyUrl.includes(prefix)) setIssued(null);
      const remaining = await refresh();
      setStatus('idle');
      await setByok(remaining.length > 0);
    } catch (e) {
      setStatus('error'); setMsg(e instanceof Error ? e.message : 'Network error.');
    }
  }

  function issuedEnvHint(p: string, url: string) {
    if (p === 'azure' || p === 'azure-openai') return `export AZURE_OPENAI_ENDPOINT=${url}`;
    if (p === 'openai') return `export OPENAI_BASE_URL=${url}/v1`;
    return `export ANTHROPIC_BASE_URL=${url}`;
  }

  const showForm = adding || keys?.length === 0;

  return (
    <Panel
      title="Provider keys"
      count="bring your own key"
      actions={keys && keys.length > 0 && !adding ? <Button size={28} onClick={() => setAdding(true)}>+ Add a provider key</Button> : undefined}
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12 }}>
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--tx2)' }}>
          Each key gets its own proxy URL. WhiteRoom stores only a hash; the key stays yours.
        </p>

        {issued && (
          <Banner variant="info" icon="check">
            <div style={{ display: 'grid', gap: 8 }}>
              <span>Key ending {issued.keyHint} connected. Point your agent at this URL. It&rsquo;s shown once, so copy it now.</span>
              <CopyChip text={issued.proxyUrl} label="Copy the proxy URL" />
              <CopyChip text={issuedEnvHint(issued.provider, issued.proxyUrl)} label="Copy the environment line" />
            </div>
          </Banner>
        )}

        {keys === null ? (
          <p style={{ margin: 0, fontSize: 13, color: 'var(--tx2)' }}>Loading connected keys&hellip;</p>
        ) : keys.length > 0 && (
          <ul className="wr-key-list">
            {keys.map((k) => (
              <li key={`${k.wrKey}-${k.createdAt}`}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{PROVIDER_LABELS[k.provider] ?? k.provider}</span>
                <span style={{ fontFamily: FONT_MONO, fontSize: 12, color: 'var(--tx2)' }}>key ending {k.keyHint}</span>
                <span style={{ fontSize: 12, color: 'var(--tx2)' }}>added {fmtDay(k.createdAt)}</span>
                <span className="wr-key-endpoint" style={{ fontFamily: FONT_MONO, fontSize: 11.5, color: 'var(--tx2)' }} title={k.endpoint}>{k.endpoint ?? ''}</span>
                <Button variant="danger" size={28} disabled={status === 'saving'} onClick={() => setRemoving(k)} style={{ marginLeft: 'auto' }}>Remove&hellip;</Button>
              </li>
            ))}
          </ul>
        )}

        {showForm && (
          <div style={{ display: 'grid', gap: 8 }}>
            {isAzure && (
              <input
                type="text"
                aria-label="Azure endpoint"
                value={endpoint}
                onChange={(e) => { setEndpoint(e.target.value); setStatus('idle'); }}
                placeholder="Azure endpoint, e.g. https://myresource.openai.azure.com"
                className="wr-input"
              />
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="password"
                aria-label={isAzure ? 'Azure API key' : 'Provider API key'}
                value={value}
                onChange={(e) => { setValue(e.target.value); setStatus('idle'); }}
                placeholder={isAzure ? 'Azure API key' : 'sk-ant-… or sk-…'}
                className="wr-input"
                style={{ flex: 1, minWidth: 0 }}
              />
              <Button variant="primary" onClick={() => void connect().then((ok) => { if (ok) setAdding(false); })} busy={status === 'saving'} busyLabel="Connecting…">Connect</Button>
              {adding && <Button variant="ghost" onClick={() => { setAdding(false); setValue(''); setEndpoint(''); setStatus('idle'); }}>Cancel</Button>}
            </div>
          </div>
        )}
        {status === 'error' && <p role="alert" style={{ margin: 0, fontSize: 12.5, color: 'var(--bad)' }}>{msg}</p>}
      </div>

      <ConfirmDialog
        open={removing !== null}
        title={removing ? `Remove the ${PROVIDER_LABELS[removing.provider] ?? removing.provider} key ending ${removing.keyHint}?` : ''}
        body={<>Its proxy URL stops working at once. Agents still pointed at it will fail until you point them elsewhere.</>}
        confirmLabel="Remove key"
        busy={status === 'saving'}
        onConfirm={() => { const k = removing; setRemoving(null); if (k) void disconnect(k); }}
        onCancel={() => setRemoving(null)}
      />
    </Panel>
  );
}

const PROVIDER_TABS: { value: ProviderTab; label: string; disabled?: boolean }[] = [
  { value: 'direct', label: 'Anthropic or OpenAI' },
  { value: 'azure', label: 'Azure OpenAI' },
  { value: 'aws', label: 'AWS Bedrock · soon', disabled: true },
];

/** "sk-wr-…7f3a": enough to recognise the key without showing it. */
function maskKey(key: string): string {
  return key.length > 12 ? `${key.slice(0, 6)}…${key.slice(-4)}` : '••••';
}

export function Onboarding({ name, email, apiKey, fleetId, fleetToken, isNew, previewKeys }: Props & { previewKeys?: ProviderKey[] }) {
  const [showKey, setShowKey] = useState(isNew);
  const [tab, setTab] = useState<ProviderTab>('direct');

  useEffect(() => {
    // Hand the fresh fleet token to server-side custody: POST it to the
    // session route, which validates it and sets the httpOnly wr_fleet_auth
    // cookie. Nothing is written to localStorage any more — the token never
    // stays reachable from page script. Fire-and-forget, like the local
    // write it replaces; the Citadel pages re-check the session on load.
    if (!fleetToken) return;
    fetch('/api/fleet/session', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: fleetToken }),
    }).catch(() => {});
  }, [fleetToken]);

  return (
    <>
      <PageHeader title="Fleet key" fleetId={email} fleetTitle="Signed in as" />
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        <main style={{ maxWidth: 760, margin: '0 auto', padding: 24, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 16 }}>
          {isNew && (
            <Banner variant="info" icon="check">Welcome, {name}. Your account is ready: point an agent at WhiteRoom below and it appears on <a href={ROUTES.home} className="wr-link">Home</a> on its first call.</Banner>
          )}

          <Panel title="Your API key">
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 10 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <code className="wr-key-field">{showKey ? apiKey : maskKey(apiKey)}</code>
                <Button onClick={() => setShowKey((v) => !v)} aria-pressed={showKey}>{showKey ? 'Hide' : 'Reveal'}</Button>
                {/* Reveal first: copying a secret you can't see is easy to do by accident. */}
                <CopyValueButton text={apiKey} what="your API key" disabled={!showKey} title={showKey ? undefined : 'Reveal the key to copy it'} />
              </div>
              <p style={{ margin: 0, fontSize: 12.5, color: 'var(--tx2)' }}>
                Use this key to authenticate CLI commands and API requests. Keep it private; anyone with it can act on this fleet.
              </p>
            </div>
          </Panel>

          <Panel title="Point your agent at WhiteRoom">
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 14 }}>
              <SegmentedControl<ProviderTab> label="Provider" value={tab} onChange={setTab} options={PROVIDER_TABS} />
              {tab === 'direct' ? (
                <>
                  <p style={{ margin: 0, fontSize: 13, color: 'var(--tx2)' }}>Change one URL so your agent&rsquo;s calls go through WhiteRoom. No code changes; run your agent exactly as before.</p>
                  <CopyChip text={SETUP_LINES.anthropic} label="Copy the Anthropic setup line" />
                  <CopyChip text={SETUP_LINES.openai} label="Copy the OpenAI setup line" />
                </>
              ) : (
                <>
                  <p style={{ margin: 0, fontSize: 13, color: 'var(--tx2)' }}>
                    Add your Azure OpenAI key and resource endpoint (Azure portal → your resource → Keys and Endpoint) under Provider keys below. You get back a proxy URL: point your agent at it instead of Azure, and keep your key, deployment names and api-version as they are.
                  </p>
                  <AzureStep label="Set your proxy URL (shown when you connect your key)" code={`export AZURE_OPENAI_ENDPOINT=${PROXY_ORIGIN}/<your-proxy-key>`} />
                  <AzureStep label="Your Azure API key stays the same" code="export AZURE_OPENAI_API_KEY=<your-azure-api-key>" />
                  <AzureStep label="The AzureOpenAI client picks both up; nothing else changes" code={`from openai import AzureOpenAI\n\nclient = AzureOpenAI(api_version="2024-10-21")  # your usual api-version\nclient.chat.completions.create(\n    model="<your-deployment-name>",\n    messages=[{"role": "user", "content": "Hello"}],\n)`} />
                  <AzureStep label="Or with the OpenAI SDK against Azure's v1 API" code={`from openai import OpenAI\n\nclient = OpenAI(\n    base_url="${PROXY_ORIGIN}/<your-proxy-key>/openai/v1",\n    api_key="<your-azure-api-key>",\n)`} />
                </>
              )}
            </div>
          </Panel>

          <ByokCard apiKey={apiKey} fleetId={fleetId} fleetToken={fleetToken} tab={tab} previewKeys={previewKeys} />

          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--tx2)', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <a href={SETUP_GUIDE_URL} className="wr-link">Setup guide</a>
            <a href="https://whiteroom.tech/openapi.yaml" className="wr-link">OpenAPI</a>
            <a href={ROUTES.sandbox} className="wr-link">Test in Sandbox &rarr;</a>
          </p>
        </main>
      </div>
    </>
  );
}

function AzureStep({ label, code }: { label: string; code: string }) {
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <span style={{ fontSize: 12, color: 'var(--tx2)' }}>{label}</span>
      <CopyChip text={code} label={`Copy: ${label}`} />
    </div>
  );
}
