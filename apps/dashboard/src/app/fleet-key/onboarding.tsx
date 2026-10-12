'use client';

import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { setByok } from '@/lib/users';
import { EMPTY_KEY_FORM, PROVIDER_LABELS, agentNamingFor, issuedEnvHint, keyFormReducer, providerKeyRequest } from '@/lib/provider-key-form';
import type { ProviderKeyRequest, ProviderTab } from '@/lib/provider-key-form';
import { deleteProviderKey, listProviderKeys, storeProviderKey } from '@/lib/whiteroom/client';
import type { FleetAuth } from '@/lib/whiteroom/client';
import type { ProviderKey } from '@/lib/whiteroom/types';
import { Banner, Button, Panel, SegmentedControl, FONT_MONO } from '@whiteroom/ui';
import { PageHeader } from '@/components/citadel/PageChrome';
import { ConfirmDialog } from '@/components/citadel/ConfirmDialog';
import { CopyChip, CopyValueButton } from '@/components/citadel/CopyChip';
import { ROUTES } from '@/lib/routes';
import { AGENT_PY_HEADERS, BEDROCK_LINES, BEDROCK_NOTES, PROXY_ORIGIN, SETUP_GUIDE_URL, SETUP_LINES } from '@/lib/setup';
import { AgentNaming } from '@/components/citadel/AgentNaming';
import { fmtDay } from '@/lib/format';

interface Props {
  name: string;
  email: string;
  apiKey: string;
  fleetId: string;
  fleetToken: string | null;
  isNew: boolean;
}

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
  const [issued, setIssued] = useState<{ proxyUrl: string; keyHint: string; provider: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ProviderKey | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState('');

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

  /** Stores the key; null when it connected, otherwise the reason it didn't. */
  async function connect(req: ProviderKeyRequest): Promise<string | null> {
    if (previewKeys) return 'Keys can’t be connected in the preview.';
    try {
      const result = await storeProviderKey(auth, req.key, req.endpoint, req.provider);
      if (!result.success || !result.proxyUrl) return result.error || 'Could not connect that key.';
      const provider = result.provider ?? req.provider ?? (req.key.startsWith('sk-ant-') ? 'anthropic' : 'openai');
      setIssued({ proxyUrl: result.proxyUrl, keyHint: result.keyHint ?? req.key.slice(-4), provider });
      setAdding(false);
      await refresh();
      await setByok(true);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : 'Network error.';
    }
  }

  async function disconnect(k: ProviderKey) {
    if (previewKeys) return;
    const prefix = k.wrKey.replace(/\.+$/, '');
    setRemoveBusy(true); setRemoveError('');
    try {
      const result = await deleteProviderKey(auth, prefix);
      if (!result.success) {
        setRemoveError(result.error || 'Could not remove that key.'); return;
      }
      if (issued?.proxyUrl.includes(prefix)) setIssued(null);
      const remaining = await refresh();
      await setByok(remaining.length > 0);
    } catch (e) {
      setRemoveError(e instanceof Error ? e.message : 'Network error.');
    } finally {
      setRemoveBusy(false);
    }
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
              <AgentNaming {...agentNamingFor(issued.provider)} />
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
                <Button variant="danger" size={28} disabled={removeBusy} onClick={() => setRemoving(k)} style={{ marginLeft: 'auto' }}>Remove&hellip;</Button>
              </li>
            ))}
          </ul>
        )}

        {/* key={tab}: each tab takes a different kind of key and second field
            (Azure URL, AWS region), so switching remounts the form empty. */}
        {showForm && <KeyForm key={tab} tab={tab} onConnect={connect} onCancel={adding ? () => setAdding(false) : undefined} />}
        {removeError && <p role="alert" style={{ margin: 0, fontSize: 12.5, color: 'var(--bad)' }}>{removeError}</p>}
      </div>

      <ConfirmDialog
        open={removing !== null}
        title={removing ? `Remove the ${PROVIDER_LABELS[removing.provider] ?? removing.provider} key ending ${removing.keyHint}?` : ''}
        body={<>Its proxy URL stops working at once. Agents still pointed at it will fail until you point them elsewhere.</>}
        confirmLabel="Remove key"
        busy={removeBusy}
        onConfirm={() => { const k = removing; setRemoving(null); if (k) void disconnect(k); }}
        onCancel={() => setRemoving(null)}
      />
    </Panel>
  );
}

/** The add-key fields for one provider tab. Mounted per tab, so it starts empty. */
function KeyForm({ tab, onConnect, onCancel }: {
  tab: ProviderTab;
  onConnect: (req: ProviderKeyRequest) => Promise<string | null>;
  onCancel?: () => void;
}) {
  const [{ value, endpoint, status, msg }, dispatch] = useReducer(keyFormReducer, EMPTY_KEY_FORM);
  const isAzure = tab === 'azure';
  const isAws = tab === 'aws';

  async function submit() {
    const check = providerKeyRequest(tab, value, endpoint);
    if (!check.ok) { dispatch({ type: 'error', msg: check.error }); return; }
    dispatch({ type: 'saving' });
    const error = await onConnect(check.request);
    dispatch(error ? { type: 'error', msg: error } : { type: 'connected' });
  }

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {(isAzure || isAws) && (
        <input
          type="text"
          aria-label={isAws ? 'Region' : 'Azure endpoint'}
          value={endpoint}
          onChange={(e) => dispatch({ type: 'edit', field: 'endpoint', text: e.target.value })}
          placeholder={isAws ? 'Region, e.g. us-east-1' : 'Azure endpoint, e.g. https://myresource.openai.azure.com'}
          autoCapitalize="none"
          spellCheck={false}
          className="wr-input"
        />
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          type="password"
          autoComplete="off"
          aria-label={isAzure ? 'Azure API key' : isAws ? 'Bedrock API key' : 'Provider API key'}
          value={value}
          onChange={(e) => dispatch({ type: 'edit', field: 'value', text: e.target.value })}
          placeholder={isAzure ? 'Azure API key' : isAws ? 'Bedrock API key' : 'sk-ant-… or sk-…'}
          className="wr-input"
          style={{ flex: 1, minWidth: 0 }}
        />
        <Button variant="primary" onClick={() => void submit()} busy={status === 'saving'} busyLabel="Connecting…">Connect</Button>
        {onCancel && <Button variant="ghost" onClick={onCancel}>Cancel</Button>}
      </div>
      {status === 'error' && <p role="alert" style={{ margin: 0, fontSize: 12.5, color: 'var(--bad)' }}>{msg}</p>}
    </div>
  );
}

const PROVIDER_TABS: { value: ProviderTab; label: string; disabled?: boolean }[] = [
  { value: 'direct', label: 'Anthropic or OpenAI' },
  { value: 'azure', label: 'Azure OpenAI' },
  { value: 'aws', label: 'AWS Bedrock' },
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
                  <p style={{ margin: 0, fontSize: 13, color: 'var(--tx2)' }}>Change one URL so your agent&rsquo;s calls go through WhiteRoom. No code changes for agents with a system prompt; run your agent exactly as before.</p>
                  <CopyChip text={SETUP_LINES.anthropic} label="Copy the Anthropic setup line" />
                  <CopyChip text={SETUP_LINES.openai} label="Copy the OpenAI setup line" />
                  <AgentNaming />
                </>
              ) : tab === 'aws' ? (
                <BedrockRecipe />
              ) : (
                <>
                  <p style={{ margin: 0, fontSize: 13, color: 'var(--tx2)' }}>
                    Add your Azure OpenAI key and resource endpoint (Azure portal → your resource → Keys and Endpoint) under Provider keys below. You get back a proxy URL: point your agent at it instead of Azure, and keep your key, deployment names and api-version as they are.
                  </p>
                  <RecipeStep label="Set your proxy URL (shown when you connect your key)" code={`export AZURE_OPENAI_ENDPOINT=${PROXY_ORIGIN}/<your-proxy-key>`} />
                  <RecipeStep label="Your Azure API key stays the same" code="export AZURE_OPENAI_API_KEY=<your-azure-api-key>" />
                  <RecipeStep label="The AzureOpenAI client picks both up; nothing else changes" code={`from openai import AzureOpenAI\n\nclient = AzureOpenAI(\n    api_version="2024-10-21",  # your usual api-version\n    ${AGENT_PY_HEADERS},  # optional if your agent has a system prompt\n)\nclient.chat.completions.create(\n    model="<your-deployment-name>",\n    messages=[{"role": "user", "content": "Hello"}],\n)`} />
                  <RecipeStep label="Or with the OpenAI SDK against Azure's v1 API" code={`from openai import OpenAI\n\nclient = OpenAI(\n    base_url="${PROXY_ORIGIN}/<your-proxy-key>/openai/v1",\n    api_key="<your-azure-api-key>",\n    ${AGENT_PY_HEADERS},  # optional if your agent has a system prompt\n)`} />
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

function RecipeStep({ label, code }: { label: string; code: string }) {
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <span style={{ fontSize: 12, color: 'var(--tx2)' }}>{label}</span>
      <CopyChip text={code} label={`Copy: ${label}`} />
    </div>
  );
}

type Lang = 'python' | 'typescript';

const LANGS: { value: Lang; label: string }[] = [
  { value: 'python', label: 'Python' },
  { value: 'typescript', label: 'TypeScript' },
];

/** Claude on AWS Bedrock: the Anthropic SDK, pointed at the proxy URL with the Bedrock API key. */
function BedrockRecipe() {
  const [lang, setLang] = useState<Lang>('python');
  return (
    <>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--tx2)' }}>
        Add your Bedrock API key and the region your Claude models run in under Provider keys below. You get back a proxy URL: point the Anthropic SDK at it instead of Bedrock and keep your Bedrock API key.
      </p>
      <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4, fontSize: 12.5, color: 'var(--tx2)' }}>
        <li>{BEDROCK_NOTES.key}</li>
        <li>{BEDROCK_NOTES.region}</li>
        <li>{BEDROCK_NOTES.custody}</li>
        <li>{BEDROCK_NOTES.model}</li>
      </ul>
      <RecipeStep label="Set your proxy URL (shown when you connect your key)" code={BEDROCK_LINES.baseUrl} />
      <RecipeStep label="Your Bedrock API key is the API key" code={BEDROCK_LINES.apiKey} />
      <div style={{ display: 'grid', gap: 6 }}>
        <span style={{ fontSize: 12, color: 'var(--tx2)' }}>Or set both on the client</span>
        <SegmentedControl<Lang> label="Language" value={lang} onChange={setLang} options={LANGS} size={24} />
        <CopyChip text={BEDROCK_LINES[lang]} label={`Copy the Bedrock ${lang === 'python' ? 'Python' : 'TypeScript'} client`} />
      </div>
    </>
  );
}
