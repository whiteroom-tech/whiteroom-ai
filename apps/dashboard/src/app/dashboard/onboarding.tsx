'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { setByok } from '@/lib/users';
import { deleteProviderKey, listProviderKeys, storeProviderKey } from '@/lib/whiteroom/client';
import type { FleetAuth } from '@/lib/whiteroom/client';
import type { FleetReport, ProviderKey } from '@/lib/whiteroom/types';
import { BrandLink, CopyButton, CodeBlock, StatCard, FONT_DISPLAY } from '@whiteroom/ui';

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
};

// BYOK: one account can connect several provider keys at once. The engine
// keeps them per fleet as a list and issues each key its own proxy URL, so an
// Anthropic key and an OpenAI key (or two Anthropic keys for different
// projects) sit side by side rather than one replacing the other. Only a hash
// and the last four characters are stored — the raw key never leaves the
// customer's control except as a per-request forward to the provider.
function ByokCard({ apiKey, fleetId, fleetToken }: { apiKey: string; fleetId: string; fleetToken: string | null }) {
  const auth = useMemo<FleetAuth>(() => ({ apiKey, fleetId, fleetToken }), [apiKey, fleetId, fleetToken]);
  const [keys, setKeys] = useState<ProviderKey[] | null>(null);
  const [value, setValue] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'error'>('idle');
  const [msg, setMsg] = useState('');
  // The full proxy URL comes back once, at creation, and is never listed
  // again — surface it immediately or it is lost.
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

  async function connect() {
    const key = value.trim();
    if (!/^sk-/.test(key) || key.length < 12) {
      setStatus('error');
      setMsg('That does not look like a provider API key (sk-ant-… for Anthropic, sk-… for OpenAI).');
      return;
    }
    setStatus('saving'); setMsg('');
    try {
      const result = await storeProviderKey(auth, key);
      if (!result.success || !result.proxyUrl) {
        setStatus('error'); setMsg(result.error || 'Could not connect that key.'); return;
      }
      setIssued({
        proxyUrl: result.proxyUrl,
        keyHint: result.keyHint ?? key.slice(-4),
        provider: result.provider ?? (key.startsWith('sk-ant-') ? 'anthropic' : 'openai'),
      });
      setValue(''); setStatus('idle');
      await refresh();
      // Persist only the flag — never the raw provider key — on the account.
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

  return (
    <section className="rounded-xl p-6 space-y-3" style={{ background: '#0A1020', border: '1px solid #1B2740' }}>
      <div>
        <h3 className="text-[11px] font-mono tracking-[.28em] uppercase font-medium" style={{ color: '#A9B8D4' }}>Bring Your Own Key</h3>
        <p className="text-xs mt-1" style={{ color: '#4E607F' }}>
          Connect as many provider keys as you need — Anthropic, OpenAI, or several of each. Every key gets its own
          proxy URL, and we store only a hash. The key stays yours.
        </p>
      </div>

      {issued && (
        <div className="rounded-lg px-4 py-3 space-y-2" style={{ background: 'rgba(63,224,160,.06)', border: '1px solid rgba(63,224,160,.2)' }}>
          <p className="text-xs" style={{ color: '#3FE0A0' }}>
            Key ending ••••{issued.keyHint} connected. Point your agent at the URL below — it is shown once.
          </p>
          <div className="flex items-center rounded-lg px-3 py-2" style={{ background: '#070B14', border: '1px solid #15203A' }}>
            <code className="text-xs font-mono flex-1 break-all" style={{ color: '#38E1FF' }}>{issued.proxyUrl}</code>
            <CopyButton text={issued.proxyUrl} />
          </div>
          <p className="text-[11px] font-mono break-all" style={{ color: '#4E607F' }}>
            {issued.provider === 'openai'
              ? `export OPENAI_BASE_URL=${issued.proxyUrl}/v1`
              : `export ANTHROPIC_BASE_URL=${issued.proxyUrl}`}
          </p>
        </div>
      )}

      {keys === null ? (
        <p className="text-xs font-mono" style={{ color: '#4E607F' }}>Loading connected keys…</p>
      ) : keys.length > 0 ? (
        <ul className="space-y-2">
          {keys.map((k) => (
            <li
              key={`${k.wrKey}-${k.createdAt}`}
              className="flex items-center gap-3 rounded-lg px-4 py-3"
              style={{ background: '#070B14', border: '1px solid #15203A' }}
            >
              <span className="text-sm font-semibold" style={{ color: '#EAF1FF' }}>
                {PROVIDER_LABELS[k.provider] ?? k.provider}
              </span>
              <code className="text-sm font-mono" style={{ color: '#FFB454' }}>••••{k.keyHint}</code>
              <span className="text-xs" style={{ color: '#4E607F' }}>
                added {new Date(k.createdAt).toLocaleDateString()}
              </span>
              <button
                onClick={() => disconnect(k)}
                disabled={status === 'saving'}
                className="ml-auto shrink-0 text-xs font-mono transition-colors cursor-pointer"
                style={{ color: '#6B7C9E', opacity: status === 'saving' ? 0.5 : 1 }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs" style={{ color: '#4E607F' }}>No provider keys connected yet.</p>
      )}

      <div className="flex items-center gap-2">
        <input
          type="password"
          value={value}
          onChange={(e) => { setValue(e.target.value); setStatus('idle'); }}
          placeholder={keys && keys.length > 0 ? 'Add another key — sk-ant-… or sk-…' : 'sk-ant-…'}
          className="flex-1 rounded-lg px-4 py-3 text-sm font-mono"
          style={{ background: '#070B14', border: '1px solid #15203A', color: '#EAF1FF' }}
        />
        <button
          onClick={connect}
          disabled={status === 'saving'}
          className="shrink-0 px-5 py-3 rounded-lg text-sm font-semibold cursor-pointer"
          style={{ background: '#132038', color: '#38E1FF', border: '1px solid #1B2740', opacity: status === 'saving' ? 0.6 : 1 }}
        >
          {status === 'saving' ? 'Working…' : 'Connect'}
        </button>
      </div>
      {status === 'error' && <p className="text-xs" style={{ color: '#ef4444' }}>{msg}</p>}
    </section>
  );
}

export function Onboarding({ name, email, apiKey, fleetId, fleetToken, report, isNew }: Props) {
  const [showKey, setShowKey] = useState(isNew);

  useEffect(() => {
    if (fleetToken) localStorage.setItem('wr_fleet_token', fleetToken);
  }, [fleetToken]);

  return (
    <div className="min-h-screen font-sans" style={{ background: '#070B14', color: '#EAF1FF' }}>
      {/* Header */}
      <header className="sticky top-0 z-50" style={{ background: 'rgba(7,11,20,.74)', backdropFilter: 'blur(16px)', borderBottom: '1px solid #15203A' }}>
        <nav className="max-w-[1200px] mx-auto flex items-center justify-between h-[66px] px-7">
          <BrandLink />
          <div className="flex items-center gap-6">
            <a href="https://whiteroom.tech/#how" className="text-sm transition-colors hover:text-[#EAF1FF]" style={{ color: '#A9B8D4', textDecoration: 'none' }}>How it works</a>
            <a href="https://whiteroom.tech/docs.html" className="text-sm transition-colors hover:text-[#EAF1FF]" style={{ color: '#A9B8D4', textDecoration: 'none' }}>Docs</a>
            <span className="text-sm" style={{ color: '#6B7C9E' }}>{email}</span>
            <a
              href="/auth/sign-out"
              className="inline-flex items-center justify-center h-[38px] px-5 rounded-lg text-sm font-semibold transition-all hover:border-[#38E1FF] hover:text-[#38E1FF]"
              style={{ border: '1px solid #1B2740', color: '#EAF1FF', textDecoration: 'none', fontFamily: FONT_DISPLAY }}
            >
              Sign out
            </a>
          </div>
        </nav>
      </header>

      <main className="max-w-[860px] mx-auto px-7 py-14 space-y-10">
        {/* Welcome banner */}
        {isNew ? (
          <div className="rounded-xl p-6" style={{ border: '1px solid rgba(63,224,160,.2)', background: 'rgba(63,224,160,.04)' }}>
            <h2 className="text-xl font-display font-bold" style={{ color: '#3FE0A0' }}>
              Welcome, {name}
            </h2>
            <p className="text-sm mt-1.5" style={{ color: '#A9B8D4' }}>
              Your account is ready. Follow the steps below to connect your first agent.
            </p>
          </div>
        ) : (
          <div>
            <h2 className="text-xl font-display font-bold">Welcome back, {name}</h2>
          </div>
        )}

        {/* Getting Started */}
        <section className="rounded-xl p-6 space-y-8" style={{ background: '#0A1020', border: '1px solid #1B2740' }}>
          <h3 className="text-[11px] font-mono tracking-[.28em] uppercase font-medium" style={{ color: '#A9B8D4' }}>Get Started in 3 Steps</h3>

          <div className="space-y-8">
            {/* Step 1 */}
            <div className="flex gap-4">
              <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-sm font-bold" style={{ background: 'rgba(56,225,255,.1)', color: '#38E1FF' }}>1</div>
              <div className="flex-1 space-y-3">
                <div>
                  <p className="text-sm font-semibold" style={{ color: '#EAF1FF' }}>Point your agent at WhiteRoom</p>
                  <p className="text-sm mt-1" style={{ color: '#6B7C9E' }}>Change one URL so your agent&apos;s API calls flow through WhiteRoom. No code changes needed — your agent runs exactly as before, but now with governance.</p>
                </div>
                <div className="space-y-2">
                  <CodeBlock label="If you use Anthropic (Claude)" code="export ANTHROPIC_BASE_URL=https://proxy.whiteroom.tech" />
                  <CodeBlock label="If you use OpenAI (GPT)" code="export OPENAI_BASE_URL=https://proxy.whiteroom.tech/v1" />
                </div>
              </div>
            </div>

            {/* Step 2 */}
            <div className="flex gap-4">
              <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-sm font-bold" style={{ background: 'rgba(56,225,255,.1)', color: '#38E1FF' }}>2</div>
              <div className="flex-1 space-y-3">
                <div>
                  <p className="text-sm font-semibold" style={{ color: '#EAF1FF' }}>Run your agent</p>
                  <p className="text-sm mt-1" style={{ color: '#6B7C9E' }}>Run your agent exactly as before. WhiteRoom auto-registers, auto-pairs, and starts governance automatically when your first API call flows through the proxy.</p>
                </div>
                <CodeBlock label="That's it — no CLI commands needed" code="python my_agent.py # or node agent.js, etc." />
              </div>
            </div>

            {/* Step 3 */}
            <div className="flex gap-4">
              <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-sm font-bold" style={{ background: 'rgba(56,225,255,.1)', color: '#38E1FF' }}>3</div>
              <div className="flex-1 space-y-3">
                <div>
                  <p className="text-sm font-semibold" style={{ color: '#EAF1FF' }}>View your dashboard</p>
                  <p className="text-sm mt-1" style={{ color: '#6B7C9E' }}>Watch your agents in real time — tasks completed, token savings, handover history, and the full audit trail.</p>
                </div>
                <CodeBlock label="Open in your browser" code="https://app.whiteroom.tech/fleet" />
              </div>
            </div>
          </div>
        </section>

        {/* Bring Your Own Key */}
        <ByokCard apiKey={apiKey} fleetId={fleetId} fleetToken={fleetToken} />

        {/* Live Dashboard + Fleet Status row */}
        <div className={`grid gap-4 ${report ? 'grid-cols-[1fr_1fr]' : ''}`}>
          <a
            href="/fleet"
            className="rounded-xl p-6 flex items-center gap-4 transition-all group"
            style={{ background: '#0A1020', border: '1px solid #1B2740', textDecoration: 'none' }}
          >
            <div className="w-12 h-12 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'rgba(56,225,255,.1)' }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#38E1FF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
            </div>
            <div>
              <p className="text-base font-semibold group-hover:text-[#38E1FF] transition-colors" style={{ color: '#EAF1FF' }}>Live Dashboard</p>
              <p className="text-sm mt-0.5" style={{ color: '#6B7C9E' }}>Monitor your agents in real time</p>
            </div>
            <svg className="ml-auto shrink-0 opacity-40 group-hover:opacity-100 transition-opacity" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#38E1FF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          </a>

          {report && (
            <div className="rounded-xl p-6" style={{ background: '#0A1020', border: '1px solid #1B2740' }}>
              <p className="text-[11px] font-mono tracking-[.28em] uppercase font-medium mb-3" style={{ color: '#A9B8D4' }}>Fleet Status</p>
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

        {/* API Key */}
        <section className="rounded-xl p-6 space-y-3" style={{ background: '#0A1020', border: '1px solid #1B2740' }}>
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-[11px] font-mono tracking-[.28em] uppercase font-medium" style={{ color: '#A9B8D4' }}>Your API Key</h3>
              <p className="text-xs mt-1" style={{ color: '#4E607F' }}>Use this key to authenticate all CLI commands and API requests.</p>
            </div>
            <button
              onClick={() => setShowKey(!showKey)}
              className="text-xs font-mono transition-colors cursor-pointer"
              style={{ color: '#6B7C9E' }}
            >
              {showKey ? 'Hide' : 'Reveal'}
            </button>
          </div>
          <div className="flex items-center rounded-lg px-4 py-3" style={{ background: '#070B14', border: '1px solid #15203A' }}>
            <code className="text-sm font-mono flex-1 break-all" style={{ color: '#FFB454' }}>
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
              className="text-sm transition-colors hover:text-[#38E1FF]"
              style={{ color: '#6B7C9E' }}
            >
              {link.label}
            </a>
          ))}
        </footer>
      </main>
    </div>
  );
}
