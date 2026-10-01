'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { setByok } from '@/lib/users';
import { azureOpenAIEndpoint } from '@/lib/azure-endpoint';
import { deleteProviderKey, listProviderKeys, storeProviderKey } from '@/lib/whiteroom/client';
import type { FleetAuth } from '@/lib/whiteroom/client';
import type { FleetReport, ProviderKey } from '@/lib/whiteroom/types';
import { CopyButton, CodeBlock, StatCard } from '@whiteroom/ui';
import { PageHeader } from '@/components/citadel/PageChrome';
import { ROUTES } from '@/lib/routes';

interface Props {
  name: string;
  email: string;
  apiKey: string;
  fleetId: string;
  fleetToken: string | null;
  report: FleetReport | null;
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
function ByokCard({ apiKey, fleetId, fleetToken, tab }: { apiKey: string; fleetId: string; fleetToken: string | null; tab: ProviderTab }) {
  const auth = useMemo<FleetAuth>(() => ({ apiKey, fleetId, fleetToken }), [apiKey, fleetId, fleetToken]);
  const [keys, setKeys] = useState<ProviderKey[] | null>(null);
  const [value, setValue] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'error'>('idle');
  const [msg, setMsg] = useState('');
  const [issued, setIssued] = useState<{ proxyUrl: string; keyHint: string; provider: string } | null>(null);

  const refresh = useCallback(async (): Promise<ProviderKey[]> => {
    const res = await listProviderKeys(auth);
    const list = res.keys ?? [];
    setKeys(list);
    return list;
  }, [auth]);

  useEffect(() => {
    refresh().catch(() => setKeys([]));
  }, [refresh]);

  const isAzure = tab === 'azure';

  async function connect() {
    const key = value.trim();
    if (isAzure) {
      if (key.length < 12) {
        setStatus('error');
        setMsg('Enter your Azure API key (from the Azure portal → Keys and Endpoint).');
        return;
      }
      const ep = endpoint.trim();
      if (!ep) {
        setStatus('error');
        setMsg('Enter your Azure endpoint URL (e.g. https://myresource.openai.azure.com).');
        return;
      }
      if (!azureOpenAIEndpoint(ep)) {
        setStatus('error');
        setMsg('Endpoint must be your Azure resource URL (e.g. https://myresource.openai.azure.com).');
        return;
      }
    } else {
      if (!/^sk-/.test(key) || key.length < 12) {
        setStatus('error');
        setMsg('That does not look like a provider API key (sk-ant-… for Anthropic, sk-… for OpenAI).');
        return;
      }
    }
    setStatus('saving'); setMsg('');
    try {
      const result = isAzure
        ? await storeProviderKey(auth, key, azureOpenAIEndpoint(endpoint) ?? undefined, 'azure-openai')
        : await storeProviderKey(auth, key);
      if (!result.success || !result.proxyUrl) {
        setStatus('error'); setMsg(result.error || 'Could not connect that key.'); return;
      }
      const provider = result.provider ?? (isAzure ? 'azure-openai' : key.startsWith('sk-ant-') ? 'anthropic' : 'openai');
      setIssued({ proxyUrl: result.proxyUrl, keyHint: result.keyHint ?? key.slice(-4), provider });
      setValue(''); setEndpoint(''); setStatus('idle');
      await refresh();
      await setByok(true);
    } catch (e) {
      setStatus('error'); setMsg(e instanceof Error ? e.message : 'Network error.');
    }
  }

  async function disconnect(k: ProviderKey) {
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

  return (
    <section className="rounded-xl p-6 space-y-3" style={{ background: 'var(--card)', border: '1px solid var(--line)' }}>
      <div>
        <h3 className="text-[11px] font-mono tracking-[.28em] uppercase font-medium" style={{ color: 'var(--tx2)' }}>Bring Your Own Key</h3>
        <p className="text-xs mt-1" style={{ color: 'var(--tx2)' }}>
          Connect as many provider keys as you need — Anthropic, OpenAI, or Azure. Every key gets its own
          proxy URL, and we store only a hash. The key stays yours.
        </p>
      </div>

      {issued && (
        <div className="rounded-lg px-4 py-3 space-y-2" style={{ background: 'var(--ok-bg)', border: '1px solid color-mix(in srgb, var(--ok) 30%, transparent)' }}>
          <p className="text-xs" style={{ color: 'var(--ok)' }}>
            Key ending ••••{issued.keyHint} connected. Point your agent at the URL below — it is shown once.
          </p>
          <div className="flex items-center rounded-lg px-3 py-2" style={{ background: 'var(--sunk)', border: '1px solid var(--line)' }}>
            <code className="text-xs font-mono flex-1 break-all" style={{ color: 'var(--brand)' }}>{issued.proxyUrl}</code>
            <CopyButton text={issued.proxyUrl} />
          </div>
          <p className="text-[11px] font-mono break-all" style={{ color: 'var(--tx2)' }}>
            {issuedEnvHint(issued.provider, issued.proxyUrl)}
          </p>
        </div>
      )}

      {keys === null ? (
        <p className="text-xs font-mono" style={{ color: 'var(--tx2)' }}>Loading connected keys…</p>
      ) : keys.length > 0 ? (
        <ul className="space-y-2">
          {keys.map((k) => (
            <li
              key={`${k.wrKey}-${k.createdAt}`}
              className="flex items-center gap-3 rounded-lg px-4 py-3"
              style={{ background: 'var(--sunk)', border: '1px solid var(--line)' }}
            >
              <span className="text-sm font-semibold" style={{ color: 'var(--tx)' }}>
                {PROVIDER_LABELS[k.provider] ?? k.provider}
              </span>
              <code className="text-sm font-mono" style={{ color: 'var(--warn)' }}>••••{k.keyHint}</code>
              <span className="text-xs" style={{ color: 'var(--tx2)' }}>
                added {new Date(k.createdAt).toLocaleDateString()}
              </span>
              {k.endpoint && (
                <span className="text-xs font-mono truncate max-w-[200px]" style={{ color: 'var(--tx2)' }} title={k.endpoint}>
                  {k.endpoint}
                </span>
              )}
              <button
                onClick={() => disconnect(k)}
                disabled={status === 'saving'}
                className="ml-auto shrink-0 text-xs font-mono transition-colors cursor-pointer"
                style={{ color: 'var(--tx2)', opacity: status === 'saving' ? 0.5 : 1 }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs" style={{ color: 'var(--tx2)' }}>No provider keys connected yet.</p>
      )}

      <div className="space-y-2">
        {isAzure && (
          <input
            type="text"
            value={endpoint}
            onChange={(e) => { setEndpoint(e.target.value); setStatus('idle'); }}
            placeholder="Azure endpoint — https://myresource.openai.azure.com"
            className="w-full rounded-lg px-4 py-3 text-sm font-mono"
            style={{ background: 'var(--sunk)', border: '1px solid var(--line)', color: 'var(--tx)' }}
          />
        )}
        <div className="flex items-center gap-2">
          <input
            type="password"
            value={value}
            onChange={(e) => { setValue(e.target.value); setStatus('idle'); }}
            placeholder={isAzure
              ? 'Azure API key'
              : (keys && keys.length > 0 ? 'Add another key — sk-ant-… or sk-…' : 'sk-ant-…')}
            className="flex-1 rounded-lg px-4 py-3 text-sm font-mono"
            style={{ background: 'var(--sunk)', border: '1px solid var(--line)', color: 'var(--tx)' }}
          />
          <button
            onClick={connect}
            disabled={status === 'saving'}
            className="shrink-0 px-5 py-3 rounded-lg text-sm font-semibold cursor-pointer"
            style={{ background: 'var(--raised)', color: 'var(--brand)', border: '1px solid var(--line)', opacity: status === 'saving' ? 0.6 : 1 }}
          >
            {status === 'saving' ? 'Working…' : 'Connect'}
          </button>
        </div>
      </div>
      {status === 'error' && <p className="text-xs" style={{ color: 'var(--bad)' }}>{msg}</p>}
    </section>
  );
}

const PROVIDER_TABS: { key: ProviderTab; label: string; soon?: boolean }[] = [
  { key: 'direct', label: 'Anthropic / OpenAI' },
  { key: 'azure', label: 'Azure OpenAI' },
  { key: 'aws', label: 'AWS Bedrock', soon: true },
];

function ProviderPills({ value, onChange }: { value: ProviderTab; onChange: (v: ProviderTab) => void }) {
  return (
    <div className="flex gap-2 flex-wrap">
      {PROVIDER_TABS.map((t) => {
        const active = value === t.key;
        return (
          <button
            key={t.key}
            onClick={() => !t.soon && onChange(t.key)}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-medium transition-all cursor-pointer"
            style={{
              background: active ? 'var(--brand-dim)' : 'transparent',
              border: `1px solid ${active ? 'var(--brand)' : 'var(--line)'}`,
              color: active ? 'var(--brand)' : 'var(--tx2)',
              cursor: t.soon ? 'default' : 'pointer',
              opacity: t.soon ? 0.6 : 1,
            }}
          >
            {t.label}
            {t.soon && (
              <span className="text-[10px] font-mono uppercase tracking-wider" style={{ color: 'var(--tx2)' }}>Soon</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function Onboarding({ name, email, apiKey, fleetId, fleetToken, report, isNew }: Props) {
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

  // A fleet that has done work doesn't need the setup steps up front.
  const active = (report?.agentCount ?? 0) > 0 || (report?.totals?.tasks ?? 0) > 0;

  const setupSteps = (
      <section className="rounded-xl p-6 space-y-8" style={{ background: 'var(--card)', border: '1px solid var(--line)' }}>
        <h3 className="text-[11px] font-mono tracking-[.28em] uppercase font-medium" style={{ color: 'var(--tx2)' }}>Get Started in 3 Steps</h3>

        <div className="space-y-8">
          {/* Step 1 */}
          <div className="flex gap-4">
            <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-sm font-bold" style={{ background: 'var(--brand-dim)', color: 'var(--brand)' }}>1</div>
            <div className="flex-1 space-y-3">
              <div>
                <p className="text-sm font-semibold" style={{ color: 'var(--tx)' }}>
                  {tab === 'azure' ? 'Connect your Azure key' : 'Point your agent at WhiteRoom'}
                </p>
                <p className="text-sm mt-1" style={{ color: 'var(--tx2)' }}>
                  {tab === 'azure'
                    ? 'Add your Azure OpenAI key and resource endpoint (Azure portal → your resource → Keys and Endpoint) in Bring Your Own Key below. You get back a proxy URL — point your agent at it instead of Azure, and keep your key, deployment names and api-version exactly as they are.'
                    : 'Change one URL so your agent’s API calls flow through WhiteRoom. No code changes needed — your agent runs exactly as before, but now with governance.'}
                </p>
              </div>
              {tab === 'direct' && (
                <div className="space-y-2">
                  <CodeBlock label="If you use Anthropic (Claude)" code="export ANTHROPIC_BASE_URL=https://proxy.whiteroom.tech" />
                  <CodeBlock label="If you use OpenAI (GPT)" code="export OPENAI_BASE_URL=https://proxy.whiteroom.tech/v1" />
                </div>
              )}
              {tab === 'azure' && (
                <div className="space-y-2">
                  <CodeBlock label="Set your proxy URL (you'll get this after connecting your key)" code="export AZURE_OPENAI_ENDPOINT=https://proxy.whiteroom.tech/<your-proxy-key>" />
                  <CodeBlock label="Your Azure API key stays the same" code="export AZURE_OPENAI_API_KEY=<your-azure-api-key>" />
                  <CodeBlock
                    label="The AzureOpenAI client picks both up — nothing else changes"
                    code={`from openai import AzureOpenAI\n\nclient = AzureOpenAI(api_version="2024-10-21")  # your usual api-version\nclient.chat.completions.create(\n    model="<your-deployment-name>",\n    messages=[{"role": "user", "content": "Hello"}],\n)`}
                  />
                  <CodeBlock
                    label="Or with the OpenAI SDK against Azure's v1 API"
                    code={`from openai import OpenAI\n\nclient = OpenAI(\n    base_url="https://proxy.whiteroom.tech/<your-proxy-key>/openai/v1",\n    api_key="<your-azure-api-key>",\n)`}
                  />
                </div>
              )}
            </div>
          </div>

          {/* Step 2 */}
          <div className="flex gap-4">
            <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-sm font-bold" style={{ background: 'var(--brand-dim)', color: 'var(--brand)' }}>2</div>
            <div className="flex-1 space-y-3">
              <div>
                <p className="text-sm font-semibold" style={{ color: 'var(--tx)' }}>Run your agent</p>
                <p className="text-sm mt-1" style={{ color: 'var(--tx2)' }}>Run your agent exactly as before. WhiteRoom auto-registers, auto-pairs, and starts governance automatically when your first API call flows through the proxy.</p>
              </div>
              <CodeBlock label="That's it — no CLI commands needed" code="python my_agent.py # or node agent.js, etc." />
            </div>
          </div>

          {/* Step 3 */}
          <div className="flex gap-4">
            <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-sm font-bold" style={{ background: 'var(--brand-dim)', color: 'var(--brand)' }}>3</div>
            <div className="flex-1 space-y-3">
              <div>
                <p className="text-sm font-semibold" style={{ color: 'var(--tx)' }}>View your dashboard</p>
                <p className="text-sm mt-1" style={{ color: 'var(--tx2)' }}>Watch your agents in real time — tasks completed, token savings, handover history, and the full audit trail.</p>
              </div>
              <a href={ROUTES.home} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm font-semibold hover:underline" style={{ color: 'var(--brand)' }}>
                Open the Control Room
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 17L17 7M8 7h9v9"/></svg>
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            </div>
          </div>
        </div>
      </section>
  );

  const liveRow = (
      <div className={`grid gap-4 ${report ? 'grid-cols-[1fr_1fr]' : ''}`}>
        <a
          href={ROUTES.home}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-xl p-6 flex items-center gap-4 transition-all group"
          style={{ background: 'var(--card)', border: '1px solid var(--line)', textDecoration: 'none' }}
        >
          <div className="w-12 h-12 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'var(--brand-dim)' }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" style={{ color: 'var(--brand)' }} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
          </div>
          <div>
            <p className="text-base font-semibold group-hover:text-[var(--brand)] transition-colors" style={{ color: 'var(--tx)' }}>Live Dashboard</p>
            <p className="text-sm mt-0.5" style={{ color: 'var(--tx2)' }}>Monitor your agents in real time</p>
          </div>
          <svg className="ml-auto shrink-0 opacity-40 group-hover:opacity-100 transition-opacity" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" style={{ color: 'var(--brand)' }} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 17L17 7M8 7h9v9"/></svg>
          <span className="sr-only">(opens in a new tab)</span>
        </a>

        {report && (
          <div className="rounded-xl p-6" style={{ background: 'var(--card)', border: '1px solid var(--line)' }}>
            <p className="text-[11px] font-mono tracking-[.28em] uppercase font-medium mb-3" style={{ color: 'var(--tx2)' }}>Fleet Status</p>
            <div className="grid grid-cols-3 gap-3">
              <StatCard label="Agents" value={report.agentCount ?? 0} />
              <StatCard label="Tasks" value={report.totals?.tasks ?? 0} />
              <StatCard
                label="Tokens"
                value={`${((report.totals?.tokens ?? 0) / 1000).toFixed(1)}K`}
              />
            </div>
          </div>
        )}
      </div>
  );

  return (
    <>
      <PageHeader title="Fleet key" fleetId={email} fleetTitle="Signed in as" />
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        <main className="max-w-[860px] mx-auto px-7 py-14 space-y-10">
          {/* Welcome banner */}
          {isNew ? (
            <div className="rounded-xl p-6" style={{ border: '1px solid color-mix(in srgb, var(--ok) 30%, transparent)', background: 'var(--ok-bg)' }}>
              <h2 className="text-xl font-display font-bold" style={{ color: 'var(--ok)' }}>
                Welcome, {name}
              </h2>
              <p className="text-sm mt-1.5" style={{ color: 'var(--tx2)' }}>
                Your account is ready. Follow the steps below to connect your first agent.
              </p>
            </div>
          ) : (
            <div>
              <h2 className="text-xl font-display font-bold">Welcome back, {name}</h2>
            </div>
          )}

          {active && liveRow}

          {/* Provider selector */}
          <ProviderPills value={tab} onChange={setTab} />

          {/* Getting Started — collapsed once the fleet has run work, so
              returning users land on the Control Room link, not setup. */}
          {active ? (
            <details className="group/setup space-y-4">
              <summary className="rounded-xl cursor-pointer list-none px-6 py-4 flex items-center justify-between text-[11px] font-mono tracking-[.28em] uppercase font-medium" style={{ background: 'var(--card)', border: '1px solid var(--line)', color: 'var(--tx2)' }}>
                Setup guide
                <span aria-hidden="true" className="transition-transform group-open/setup:rotate-90">▸</span>
              </summary>
              {setupSteps}
            </details>
          ) : (
            setupSteps
          )}

          {/* Bring Your Own Key */}
          <ByokCard apiKey={apiKey} fleetId={fleetId} fleetToken={fleetToken} tab={tab} />

          {!active && liveRow}

          {/* API Key */}
          <section className="rounded-xl p-6 space-y-3" style={{ background: 'var(--card)', border: '1px solid var(--line)' }}>
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-[11px] font-mono tracking-[.28em] uppercase font-medium" style={{ color: 'var(--tx2)' }}>Your API Key</h3>
                <p className="text-xs mt-1" style={{ color: 'var(--tx2)' }}>Use this key to authenticate all CLI commands and API requests.</p>
              </div>
              <button
                onClick={() => setShowKey(!showKey)}
                className="text-xs font-mono transition-colors cursor-pointer"
                style={{ color: 'var(--tx2)' }}
              >
                {showKey ? 'Hide' : 'Reveal'}
              </button>
            </div>
            <div className="flex items-center rounded-lg px-4 py-3" style={{ background: 'var(--sunk)', border: '1px solid var(--line)' }}>
              <code className="text-sm font-mono flex-1 break-all" style={{ color: 'var(--warn)' }}>
                {showKey ? apiKey : '•'.repeat(46)}
              </code>
              <CopyButton text={apiKey} disabled={!showKey} />
            </div>
          </section>

          {/* Footer links */}
          <footer className="flex items-center gap-6 pt-4 pb-8">
            {[
              { label: 'Docs', href: 'https://whiteroom.tech/docs.html' },
              { label: 'SDK', href: 'https://whiteroom.tech/docs.html#sdk' },
              { label: 'OpenAPI', href: 'https://whiteroom.tech/openapi.yaml' },
              { label: 'GitHub', href: 'https://github.com/rashadhaque/whiteroom-ai' },
            ].map(link => (
              <a
                key={link.label}
                href={link.href}
                className="text-sm transition-colors hover:text-[var(--brand)]"
                style={{ color: 'var(--tx2)' }}
              >
                {link.label}
              </a>
            ))}
          </footer>
        </main>
      </div>
    </>
  );
}
