'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { setByok } from '@/lib/users';
import { EMPTY_KEY_FORM, PROVIDER_LABELS, agentNamingFor, canSubmitKey, issuedEnvHint, keyFormReducer, keyFormRequest } from '@/lib/provider-key-form';
import type { ProviderKeyRequest, ProviderTab } from '@/lib/provider-key-form';
import { EMPTY_ROLE_FORM, bedrockRoleRequest, canSubmitRoleForm, generateExternalId, roleFormReducer } from '@/lib/bedrock-role-form';
import type { BedrockRoleRequest } from '@/lib/bedrock-role-form';
import { deleteBedrockRole, deleteProviderKey, getBedrockRoleStatus, listProviderKeys, storeBedrockRole, storeProviderKey } from '@/lib/whiteroom/client';
import type { FleetAuth } from '@/lib/whiteroom/client';
import type { BedrockRoleStatus, ProviderKey } from '@/lib/whiteroom/types';
import { Banner, Button, SegmentedControl, FONT_MONO } from '@whiteroom/ui';
import { PageHeader, PageLead } from '@/components/citadel/PageChrome';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { ConfirmDialog } from '@/components/citadel/ConfirmDialog';
import { CopyChip, CopyValueButton } from '@/components/citadel/CopyChip';
import { ROUTES } from '@/lib/routes';
import {
  AGENT_PY_HEADERS,
  BEDROCK_KEY_ENV,
  BEDROCK_LINES,
  BEDROCK_NOTES,
  BEDROCK_ROLE_LINES,
  BEDROCK_ROLE_SUPPORT,
  PROXY_ORIGIN,
  SETUP_GUIDE_URL,
  SETUP_LINES,
  bedrockRoleTrustPolicy,
} from '@/lib/setup';
import { AgentNaming } from '@/components/citadel/AgentNaming';
import { fmtDay } from '@/lib/format';
import type { CredentialChange } from '@/lib/owner-credentials';
import { RotateDialog, RotationResult } from './rotate';

/** AWS Bedrock has two unrelated ways in: a bearer key (Claude only, via Mantle) or a cross-account IAM role (any model, via WhiteRoom's native adapter). */
type BedrockMode = 'api-key' | 'role';

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
  const [replacing, setReplacing] = useState(false);
  const [replaced, setReplaced] = useState<Extract<CredentialChange, { ok: true }> | null>(null);

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
      const result = await storeProviderKey(auth, req.key, req.endpoint, req.provider, req.boundAgent);
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
    <SettingsCard
      id="provider-keys"
      title="Provider keys"
      sub="Bring your own key. Each key gets its own proxy URL; WhiteRoom stores only a hash and the last 4 characters, never the key itself."
      right={keys && keys.length > 0 && !adding ? (
        <>
          <Button size={28} onClick={() => setReplacing(true)}>Replace URLs&hellip;</Button>
          <Button size={28} onClick={() => setAdding(true)}>+ Add a provider key</Button>
        </>
      ) : undefined}
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12 }}>

        {replaced && <RotationResult result={replaced} onDismiss={() => setReplaced(null)} />}

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
          <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>Loading connected keys&hellip;</p>
        ) : keys.length > 0 && (
          <ul className="wr-key-list">
            {keys.map((k) => (
              <li key={`${k.wrKey}-${k.createdAt}`}>
                <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 600 }}>{PROVIDER_LABELS[k.provider] ?? k.provider}</span>
                <span style={{ fontFamily: FONT_MONO, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>key ending {k.keyHint}</span>
                <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>added {fmtDay(k.createdAt)}</span>
                {k.agentId && <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>only for {k.agentId}</span>}
                <span className="wr-key-endpoint" style={{ fontFamily: FONT_MONO, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }} title={k.endpoint}>{k.endpoint ?? ''}</span>
                <Button variant="danger" size={28} className="wr-btn--outline-bad" disabled={removeBusy} onClick={() => setRemoving(k)} style={{ marginLeft: 'auto' }}>Remove&hellip;</Button>
              </li>
            ))}
          </ul>
        )}

        {/* key={tab}: each tab takes a different kind of key and second field
            (Azure URL, AWS region), so switching remounts the form empty. */}
        {showForm && <KeyForm key={tab} tab={tab} onConnect={connect} onCancel={adding ? () => setAdding(false) : undefined} />}
        {removeError && <p role="alert" style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--bad)' }}>{removeError}</p>}
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
      <RotateDialog
        kind="proxy-urls"
        preview={!!previewKeys}
        open={replacing}
        onClose={() => setReplacing(false)}
        onDone={(result) => { setReplacing(false); setIssued(null); setReplaced(result); void refresh().catch(() => {}); }}
      />
    </SettingsCard>
  );
}

/** The add-key fields for one provider tab. Mounted per tab, so it starts empty. */
function KeyForm({ tab, onConnect, onCancel }: {
  tab: ProviderTab;
  onConnect: (req: ProviderKeyRequest) => Promise<string | null>;
  onCancel?: () => void;
}) {
  const [form, dispatch] = useReducer(keyFormReducer, EMPTY_KEY_FORM);
  const { value, endpoint, agent, status, msg } = form;
  // Set synchronously, so a double click can't start two store_key calls
  // before the 'saving' render lands.
  const inFlight = useRef(false);
  const saving = status === 'saving';
  const isAzure = tab === 'azure';
  const isAws = tab === 'aws';

  async function submit() {
    if (inFlight.current || !canSubmitKey(form)) return;
    const check = keyFormRequest(tab, form);
    if (!check.ok) { dispatch({ type: 'error', msg: check.error }); return; }
    inFlight.current = true;
    dispatch({ type: 'saving' });
    try {
      const error = await onConnect(check.request);
      dispatch(error ? { type: 'error', msg: error } : { type: 'connected' });
    } finally {
      inFlight.current = false;
    }
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
          readOnly={saving}
          className="wr-input"
        />
      )}
      <input
        type="text"
        aria-label="Only for agent (optional)"
        value={agent}
        onChange={(e) => dispatch({ type: 'edit', field: 'agent', text: e.target.value })}
        placeholder="Only for agent (optional)"
        autoCapitalize="none"
        spellCheck={false}
        readOnly={saving}
        maxLength={128}
        className="wr-input"
      />
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          type="password"
          autoComplete="off"
          readOnly={saving}
          aria-label={isAzure ? 'Azure API key' : isAws ? 'Bedrock API key' : 'Provider API key'}
          value={value}
          onChange={(e) => dispatch({ type: 'edit', field: 'value', text: e.target.value })}
          placeholder={isAzure ? 'Azure API key' : isAws ? 'Bedrock API key' : 'sk-ant-… or sk-…'}
          className="wr-input"
          style={{ flex: 1, minWidth: 0 }}
        />
        <Button variant="primary" onClick={() => void submit()} busy={saving} busyLabel="Connecting…">Connect</Button>
        {onCancel && <Button variant="ghost" onClick={onCancel}>Cancel</Button>}
      </div>
      {status === 'error' && <p role="alert" style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--bad)' }}>{msg}</p>}
    </div>
  );
}

const BEDROCK_MODE_TABS: { value: BedrockMode; label: string }[] = [
  { value: 'api-key', label: 'API key (Claude)' },
  { value: 'role', label: 'Cross-account role (any model)' },
];

/**
 * The cross-account IAM role, not a key: one slot per fleet (register is an
 * upsert on the engine), fetched and shown like ByokCard's list, but for a
 * single config instead of several keys.
 */
function BedrockRoleCard({ apiKey, fleetId, fleetToken }: { apiKey: string; fleetId: string; fleetToken: string | null }) {
  const auth = useMemo<FleetAuth>(() => ({ apiKey, fleetId, fleetToken }), [apiKey, fleetId, fleetToken]);
  const [role, setRole] = useState<BedrockRoleStatus | null>(null);
  // Separate from `role`: a failed status fetch must never look like "no role
  // configured yet" — that would invite connecting a fresh role over a
  // working one with no warning.
  const [statusError, setStatusError] = useState('');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState('');

  const refresh = useCallback(async () => {
    const res = await getBedrockRoleStatus(auth);
    setRole(res);
    setStatusError('');
    return res;
  }, [auth]);

  // Never throws: a refresh failure after a successful connect/disconnect
  // must not be reported as if that mutation itself failed.
  const safeRefresh = useCallback(async () => {
    await refresh().catch((e) => setStatusError(e instanceof Error ? e.message : 'Network error.'));
  }, [refresh]);

  useEffect(() => { void safeRefresh(); }, [safeRefresh]);

  async function connect(req: BedrockRoleRequest): Promise<string | null> {
    try {
      const result = await storeBedrockRole(auth, req);
      if (!result.success) return result.error || 'Could not connect that role.';
    } catch (e) {
      return e instanceof Error ? e.message : 'Network error.';
    }
    setAdding(false);
    await safeRefresh();
    return null;
  }

  async function disconnect() {
    setRemoveBusy(true); setRemoveError('');
    try {
      const result = await deleteBedrockRole(auth);
      if (!result.success) { setRemoveError(result.error || 'Could not remove that role.'); return; }
    } catch (e) {
      setRemoveError(e instanceof Error ? e.message : 'Network error.'); return;
    } finally {
      setRemoveBusy(false);
    }
    await safeRefresh();
  }

  const showForm = adding || (role !== null && !role.configured);

  return (
    <SettingsCard
      id="bedrock-role"
      title="Cross-account role"
      sub="No API key needed"
      right={role?.configured && !adding ? <Button size={28} onClick={() => setAdding(true)}>Replace role&hellip;</Button> : undefined}
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12 }}>
        {role === null && statusError ? (
          <div style={{ display: 'grid', gap: 8 }}>
            <p role="alert" style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--bad)' }}>Couldn&rsquo;t load role status: {statusError}</p>
            <Button size={28} onClick={() => void safeRefresh()} style={{ justifySelf: 'start' }}>Retry</Button>
          </div>
        ) : role === null ? (
          <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>Loading role status&hellip;</p>
        ) : role.configured && !adding && (
          <div style={{ display: 'grid', gap: 6, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>
            <span><strong style={{ color: 'var(--tx)' }}>Account</strong> {role.awsAccountId}</span>
            <span style={{ fontFamily: FONT_MONO }}>{role.roleArn}</span>
            <span><strong style={{ color: 'var(--tx)' }}>Region</strong> {role.region}</span>
            {role.createdAt && <span>connected {fmtDay(role.createdAt)}</span>}
            <Button variant="danger" size={28} disabled={removeBusy} onClick={() => setRemoving(true)} style={{ justifySelf: 'start', marginTop: 4 }}>Remove&hellip;</Button>
          </div>
        )}

        {showForm && <RoleForm onConnect={connect} onCancel={role?.configured ? () => setAdding(false) : undefined} />}
        {removeError && <p role="alert" style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--bad)' }}>{removeError}</p>}
      </div>

      <ConfirmDialog
        open={removing}
        title="Remove the Bedrock cross-account role?"
        body={<>Calls using it fail at once until a new role is connected. The role itself (and its trust policy) stays in your AWS account until you delete it there.</>}
        confirmLabel="Remove role"
        busy={removeBusy}
        onConfirm={() => { setRemoving(false); void disconnect(); }}
        onCancel={() => setRemoving(false)}
      />
    </SettingsCard>
  );
}

/** The role_arn / external ID / region fields. Mounted fresh each time, so it never shows a previous external ID back (the engine doesn't echo it either). */
function RoleForm({ onConnect, onCancel }: {
  onConnect: (req: BedrockRoleRequest) => Promise<string | null>;
  onCancel?: () => void;
}) {
  const [form, dispatch] = useReducer(roleFormReducer, EMPTY_ROLE_FORM);
  const { roleArn, externalId, region, status, msg } = form;
  const inFlight = useRef(false);
  const saving = status === 'saving';

  async function submit() {
    if (inFlight.current || !canSubmitRoleForm(form)) return;
    const check = bedrockRoleRequest(roleArn, externalId, region);
    if (!check.ok) { dispatch({ type: 'error', msg: check.error }); return; }
    inFlight.current = true;
    dispatch({ type: 'saving' });
    try {
      const error = await onConnect(check.request);
      dispatch(error ? { type: 'error', msg: error } : { type: 'connected' });
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>
        Create a role in your AWS account first (see the trust policy below), then paste its ARN and the external ID you put in it.
      </p>
      <input
        type="text"
        aria-label="Role ARN"
        value={roleArn}
        onChange={(e) => dispatch({ type: 'edit', field: 'roleArn', text: e.target.value })}
        placeholder="arn:aws:iam::123456789012:role/WhiteRoomBedrock"
        autoCapitalize="none"
        spellCheck={false}
        readOnly={saving}
        className="wr-input"
      />
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          type="text"
          aria-label="External ID"
          value={externalId}
          onChange={(e) => dispatch({ type: 'edit', field: 'externalId', text: e.target.value })}
          placeholder="A random value, at least 20 characters"
          autoCapitalize="none"
          spellCheck={false}
          readOnly={saving}
          className="wr-input"
          style={{ flex: 1, minWidth: 0 }}
        />
        <Button onClick={() => dispatch({ type: 'edit', field: 'externalId', text: generateExternalId() })} disabled={saving}>Generate</Button>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          type="text"
          aria-label="Region"
          value={region}
          onChange={(e) => dispatch({ type: 'edit', field: 'region', text: e.target.value })}
          placeholder="Region, e.g. us-east-1"
          autoCapitalize="none"
          spellCheck={false}
          readOnly={saving}
          className="wr-input"
          style={{ flex: 1, minWidth: 0 }}
        />
        <Button variant="primary" onClick={() => void submit()} busy={saving} busyLabel="Connecting…">Connect</Button>
        {onCancel && <Button variant="ghost" onClick={onCancel}>Cancel</Button>}
      </div>
      {status === 'error' && <p role="alert" style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--bad)' }}>{msg}</p>}
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
  const [rotating, setRotating] = useState(false);
  // A rotated API key: shown once, then the page reloads onto the new key and token.
  const [rotated, setRotated] = useState<Extract<CredentialChange, { ok: true }> | null>(null);
  const [tab, setTab] = useState<ProviderTab>('direct');
  const [bedrockMode, setBedrockMode] = useState<BedrockMode>('api-key');

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
      <PageHeader title="Fleet key" fleetId={fleetId} fleetTitle={`Signed in as ${email}`} />
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        <main className="wr-setup-page">
          <PageLead>Connect an agent to WhiteRoom.</PageLead>
          <div className="wr-setup-narrow">
          {isNew && (
            <Banner variant="info" icon="check">Welcome, {name}. Your account is ready: point an agent at WhiteRoom below and it appears on <a href={ROUTES.home} className="wr-link">Home</a> on its first call.</Banner>
          )}

          <SettingsCard id="fleet-key" title="Your WhiteRoom fleet key" sub="For CLI commands and API requests" right={!rotated ? <Button variant="danger" className="wr-btn--outline-bad" onClick={() => setRotating(true)}>Rotate&hellip;</Button> : undefined}>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 10 }}>
              {rotated && <RotationResult result={rotated} onDismiss={() => window.location.reload()} />}
              {/* After a rotation the old key is dead: only the new one, in the banner, is offered. */}
              {!rotated && <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <code className="wr-key-field">{showKey ? apiKey : maskKey(apiKey)}</code>
                <Button onClick={() => setShowKey((v) => !v)} aria-pressed={showKey}>{showKey ? 'Hide' : 'Reveal'}</Button>
                {/* Reveal first: copying a secret you can't see is easy to do by accident. */}
                <CopyValueButton text={apiKey} what="your fleet key" disabled={!showKey} title={showKey ? undefined : 'Reveal the key to copy it'} />
              </div>}
              <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>
                Keep it private. Anyone with it can act on this fleet. If it leaks, rotate it.
              </p>
            </div>
            <RotateDialog kind="api-key" preview={!!previewKeys} open={rotating} onClose={() => setRotating(false)} onDone={(result) => { setRotating(false); setShowKey(false); setRotated(result); }} />
          </SettingsCard>

          <SettingsCard id="point" title="Point your agent at WhiteRoom">
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 14 }}>
              <SegmentedControl<ProviderTab> label="Provider" value={tab} onChange={setTab} options={PROVIDER_TABS} />
              {tab === 'direct' ? (
                <>
                  <p style={{ margin: 0 }}>Change one URL so your agent&rsquo;s calls go through WhiteRoom. Agents with a system prompt need no code changes.</p>
                  <CopyChip text={SETUP_LINES.anthropic} label="Copy the Anthropic setup line" />
                  <CopyChip text={SETUP_LINES.openai} label="Copy the OpenAI setup line" />
                  <AgentNaming />
                </>
              ) : tab === 'aws' ? (
                <>
                  <SegmentedControl<BedrockMode> label="Bedrock access" value={bedrockMode} onChange={setBedrockMode} options={BEDROCK_MODE_TABS} size={24} />
                  {bedrockMode === 'api-key' ? <BedrockRecipe /> : <BedrockRoleRecipe />}
                </>
              ) : (
                <>
                  <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>
                    Add your Azure OpenAI key and resource endpoint (Azure portal → your resource → Keys and Endpoint) under Provider keys below. You get back a proxy URL: point your agent at it instead of Azure, and keep your key, deployment names and api-version as they are.
                  </p>
                  <RecipeStep label="Set your proxy URL (shown when you connect your key)" code={`export AZURE_OPENAI_ENDPOINT=${PROXY_ORIGIN}/<your-proxy-key>`} />
                  <RecipeStep label="Your Azure API key stays the same" code="export AZURE_OPENAI_API_KEY=<your-azure-api-key>" />
                  <RecipeStep label="The AzureOpenAI client picks both up; nothing else changes" code={`from openai import AzureOpenAI\n\nclient = AzureOpenAI(\n    api_version="2024-10-21",  # your usual api-version\n    ${AGENT_PY_HEADERS},  # optional if your agent has a system prompt\n)\nclient.chat.completions.create(\n    model="<your-deployment-name>",\n    messages=[{"role": "user", "content": "Hello"}],\n)`} />
                  <RecipeStep label="Or with the OpenAI SDK against Azure's v1 API" code={`from openai import OpenAI\n\nclient = OpenAI(\n    base_url="${PROXY_ORIGIN}/<your-proxy-key>/openai/v1",\n    api_key="<your-azure-api-key>",\n    ${AGENT_PY_HEADERS},  # optional if your agent has a system prompt\n)`} />
                </>
              )}
            </div>
          </SettingsCard>

          {/* After a rotation the old token is gone: the cards come back on the reload. */}
          {rotated ? null : tab === 'aws' && bedrockMode === 'role' ? (
            <BedrockRoleCard apiKey={apiKey} fleetId={fleetId} fleetToken={fleetToken} />
          ) : (
            <ByokCard apiKey={apiKey} fleetId={fleetId} fleetToken={fleetToken} tab={tab} previewKeys={previewKeys} />
          )}

          <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--tx2)', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <a href={SETUP_GUIDE_URL} className="wr-link">Setup guide</a>
            <a href="https://whiteroom.tech/openapi.yaml" className="wr-link">OpenAPI</a>
            <a href={ROUTES.sandbox} className="wr-link">Test in Sandbox &rarr;</a>
          </p>
          </div>
        </main>
      </div>
    </>
  );
}

function RecipeStep({ label, code }: { label: string; code: string }) {
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>{label}</span>
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
      <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>
        Add your Bedrock API key and the region your Claude models run in under Provider keys below. You get back a proxy URL: point the Anthropic SDK at it instead of Bedrock and keep your Bedrock API key.
      </p>
      <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>
        <li>{BEDROCK_NOTES.key}</li>
        <li>{BEDROCK_NOTES.region}</li>
        <li>{BEDROCK_NOTES.custody}</li>
        <li>{BEDROCK_NOTES.model}</li>
      </ul>
      <RecipeStep label="Set your proxy URL (shown when you connect your key)" code={BEDROCK_LINES.baseUrl} />
      <RecipeStep label={`Use your Bedrock API key (${BEDROCK_KEY_ENV}) as the API key`} code={BEDROCK_LINES.apiKey} />
      <div style={{ display: 'grid', gap: 6 }}>
        <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>Or set both on the client</span>
        <SegmentedControl<Lang> label="Language" value={lang} onChange={setLang} options={LANGS} size={24} />
        <CopyChip text={BEDROCK_LINES[lang]} label={`Copy the Bedrock ${lang === 'python' ? 'Python' : 'TypeScript'} client`} />
      </div>
    </>
  );
}

/**
 * Native Bedrock Runtime, any model: your agent keeps its own AWS
 * credentials. WhiteRoom proves who's calling by replaying a signed
 * sts:GetCallerIdentity, never a bearer key — there's nothing to paste into
 * the client beyond the SDK install below.
 */
function BedrockRoleRecipe() {
  return (
    <>
      <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>
        Create an IAM role in your AWS account that trusts WhiteRoom, then connect it under Cross-account role below. No API key — your agent authenticates with its own AWS credentials; WhiteRoom verifies the call and assumes this role to reach Bedrock on its behalf.
      </p>
      <RecipeStep
        label="1. Create the role's trust policy, with the external ID you'll use below"
        code={bedrockRoleTrustPolicy('<your-external-id>')}
      />
      <RecipeStep label="2. Grant the role Bedrock access, e.g." code={'bedrock:InvokeModel\nbedrock:InvokeModelWithResponseStream\nbedrock:Converse\nbedrock:ConverseStream'} />
      <RecipeStep label="3. Install the client shim" code={BEDROCK_ROLE_LINES.pythonInstall} />
      <RecipeStep label="4. Point boto3 at WhiteRoom (JS/TS coming soon)" code={BEDROCK_ROLE_LINES.python('<your-region>')} />
      <div style={{ display: 'grid', gap: 4 }}>
        <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--tx)' }}>Supported models</span>
        <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 2, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>
          {BEDROCK_ROLE_SUPPORT.map((line) => <li key={line}>{line}</li>)}
        </ul>
      </div>
    </>
  );
}
