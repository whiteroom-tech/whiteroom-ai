'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { setByok } from '@/lib/users';
import { EMPTY_KEY_FORM, PROVIDER_LABELS, agentNamingFor, canSubmitKey, issuedEnvHint, keyFormReducer, keyFormRequest, providerTab, proxyUrlState, withProxyUrl } from '@/lib/provider-key-form';
import { KeyScopeNote } from '@/components/citadel/StopNotes';
import type { IssuedUrl, ProviderKeyRequest, ProviderTab, ProxyUrlState } from '@/lib/provider-key-form';
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
  KEY_HEADER_LINE,
  PROXY_KEY_URL,
  SETUP_GUIDE_URL,
  bedrockRoleTrustPolicy,
} from '@/lib/setup';
import { AgentNaming } from '@/components/citadel/AgentNaming';
import { fmtDay } from '@/lib/format';
import type { CredentialChange } from '@/lib/owner-credentials';
import { RotateDialog, RotationResult } from './rotate';
import { ConnectCaveat } from '@/components/ConnectCaveat';
import type { PlanState } from '@/lib/plan-banner-shared';

/** AWS Bedrock has two unrelated ways in: a bearer key (Claude only, via Mantle) or a cross-account IAM role (any model, via WhiteRoom's native adapter). */
type BedrockMode = 'api-key' | 'role';

interface Props {
  name: string;
  email: string;
  apiKey: string;
  fleetId: string;
  fleetToken: string | null;
  isNew: boolean;
  /** A one-time line above the page (after going live), from the page. */
  notice?: React.ReactNode;
  /** Under the connect card, while its line can't work yet (Free, or Suspended once refused). */
  caveat?: PlanState['caveat'];
}

// BYOK: one account can connect several provider keys at once. The engine
// keeps them per fleet as a list and issues each key its own proxy URL, so an
// Anthropic key and an OpenAI key (or two Anthropic keys for different
// projects) sit side by side rather than one replacing the other. Only a hash
// and the last four characters are stored — the raw key never leaves the
// customer's control except as a per-request forward to the provider.
function ByokCard({ apiKey, fleetId, fleetToken, tab, issued, setIssued, onKeys, previewKeys }: {
  apiKey: string; fleetId: string; fleetToken: string | null; tab: ProviderTab;
  /** The URL just issued, held by the page: the connect card above fills its lines with it. */
  issued: IssuedUrl | null;
  setIssued: (issued: IssuedUrl | null) => void;
  /** The connected keys, each time they load. */
  onKeys: (keys: ProviderKey[]) => void;
  /** /dev/fleet-key: sample keys, and nothing is fetched or changed. */
  previewKeys?: ProviderKey[];
}) {
  const auth = useMemo<FleetAuth>(() => ({ apiKey, fleetId, fleetToken }), [apiKey, fleetId, fleetToken]);
  const [keys, setKeys] = useState<ProviderKey[] | null>(previewKeys ?? null);
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
    onKeys(list);
    return list;
  }, [auth, onKeys]);

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
      if (!result.success && !result.pending) {
        setRemoveError(result.error || 'Could not remove that key.'); return;
      }
      // Off but not saved yet (pending): it stays in the list, marked, so it can be tried again.
      if (result.pending) setRemoveError(result.error || 'This key is off for now, but we couldn’t save that. Try again in a minute.');
      if (issued?.proxyUrl.includes(prefix)) setIssued(null);
      const remaining = await refresh();
      await setByok(remaining.some((key) => !key.pending));
    } catch (e) {
      setRemoveError(e instanceof Error ? e.message : 'Network error.');
    } finally {
      setRemoveBusy(false);
    }
  }

  const showForm = adding || keys?.length === 0;

  return (
    <section id="provider-keys" aria-labelledby="provider-keys-title" className="wr-keys">
      <div className="wr-keys__head">
        <div style={{ minWidth: 0 }}>
          <h3 id="provider-keys-title" className="wr-keys__title">Provider keys</h3>
          <p className="wr-scard__sub">Each key gets its own proxy URL. WhiteRoom stores only a hash and the last 4 characters, never the key itself.</p>
        </div>
        {keys && keys.length > 0 && !adding && (
          <div className="wr-scard__right">
            <Button size={28} onClick={() => setReplacing(true)}>Replace URLs&hellip;</Button>
            <Button size={28} onClick={() => setAdding(true)}>+ Add a provider key</Button>
          </div>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12 }}>

        {replaced && <RotationResult result={replaced} onDismiss={() => setReplaced(null)} />}

        {/* On its own tab the URL is in the setup just under this section. From another tab, it is shown here. */}
        {issued && providerTab(issued.provider) !== tab && (
          <Banner variant="info" icon="check">
            <div style={{ display: 'grid', gap: 8 }}>
              <span>Key ending {issued.keyHint} connected. Point your agent at this URL. It&rsquo;s shown once, so copy it now.</span>
              <CopyChip text={issued.proxyUrl} label="Copy the proxy URL" />
              <CopyChip text={issuedEnvHint(issued.provider, issued.proxyUrl)} label="Copy the environment line" />
              <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>{KEY_HEADER_LINE}</span>
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
                <KeyScopeNote agentId={k.agentId} />
                <span className="wr-key-endpoint" style={{ fontFamily: FONT_MONO, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }} title={k.endpoint}>{k.endpoint ?? ''}</span>
                {k.pending && <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>Off, saving&hellip;</span>}
                {k.pending
                  ? <Button size={28} disabled={removeBusy} onClick={() => void disconnect(k)} style={{ marginLeft: 'auto' }}>Try again</Button>
                  : <Button variant="danger" size={28} className="wr-btn--outline-bad" disabled={removeBusy} onClick={() => setRemoving(k)} style={{ marginLeft: 'auto' }}>Remove&hellip;</Button>}
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
    </section>
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
      anchor
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

export function Onboarding({ name, email, apiKey, fleetId, fleetToken, isNew, notice, caveat, previewKeys }: Props & { previewKeys?: ProviderKey[] }) {
  const [showKey, setShowKey] = useState(isNew);
  const [rotating, setRotating] = useState(false);
  // A rotated API key: shown once, then the page reloads onto the new key and token.
  const [rotated, setRotated] = useState<Extract<CredentialChange, { ok: true }> | null>(null);
  const [tab, setTab] = useState<ProviderTab>('direct');
  const [bedrockMode, setBedrockMode] = useState<BedrockMode>('api-key');
  // Held here, not in the Provider keys card: the connect card fills its lines
  // with the issued URL, and it survives the card unmounting on a tab change.
  const [issued, setIssued] = useState<IssuedUrl | null>(null);
  const [keys, setKeys] = useState<ProviderKey[] | null>(previewKeys ?? null);
  // After a rotation the cards are hidden until the reload, so nothing is said about their URLs.
  const roleMode = tab === 'aws' && bedrockMode === 'role';
  const urlState: ProxyUrlState = rotated ? { kind: 'none' } : proxyUrlState(tab, issued, keys);

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
        <div className="wr-setup-page">
          {notice}
          <PageLead>Connect an agent to WhiteRoom.</PageLead>
          <div className="wr-setup-narrow">
          {isNew && (
            <Banner variant="info" icon="check">Welcome, {name}. Your account is ready: point an agent at WhiteRoom below and it appears on <a href={ROUTES.home} className="wr-link">Home</a> on its first call.</Banner>
          )}

          <SettingsCard id="point" anchor title="Point your agent at WhiteRoom">
            {/* One card, in the order it's done: what this is, the key, then the line that key gives back.
                The Provider keys section keeps one place in this list, so a tab change doesn't remount it. */}
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 14 }}>
              <SegmentedControl<ProviderTab> label="Provider" value={tab} onChange={setTab} options={PROVIDER_TABS} />
              {tab === 'direct' ? (
                <>
                  <p style={{ margin: 0 }}>Change one URL so your agent&rsquo;s calls go through WhiteRoom. Agents with a system prompt need no code changes.</p>
                  {!rotated && urlState.kind === 'none' && <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>Connect your Anthropic or OpenAI key under <Below to="provider-keys">Provider keys below</Below>. You get back one line to set where your agent runs. Your agent keeps sending its own key.</p>}
                </>
              ) : tab === 'aws' ? (
                <>
                  <SegmentedControl<BedrockMode> label="Bedrock access" value={bedrockMode} onChange={setBedrockMode} options={BEDROCK_MODE_TABS} size={24} />
                  {bedrockMode === 'api-key' ? <BedrockLead linked={!rotated} /> : <BedrockRoleRecipe linked={!rotated} />}
                </>
              ) : (
                <>
                  <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>
                    Add your Azure OpenAI key and resource endpoint (Azure portal → your resource → Keys and Endpoint) under <Below to="provider-keys" linked={!rotated}>Provider keys below</Below>. You get back a proxy URL: point your agent at it instead of Azure, and keep your key, deployment names and api-version as they are.
                  </p>
                </>
              )}

              {/* After a rotation the old token is gone: the keys come back on the reload. In Bedrock role
                  mode the section is hidden, not unmounted: it may hold new URLs that are shown only once. */}
              {!rotated && (
                <div hidden={roleMode}>
                  <ByokCard apiKey={apiKey} fleetId={fleetId} fleetToken={fleetToken} tab={tab} issued={issued} setIssued={setIssued} onKeys={setKeys} previewKeys={previewKeys} />
                </div>
              )}

              {roleMode ? null : tab === 'direct' ? (
                <>
                  <UrlHint urlState={urlState} />
                  {urlState.kind === 'issued' && (
                    <>
                      <CopyChip text={issuedEnvHint(urlState.issued.provider, urlState.issued.proxyUrl)} label={`Copy the ${PROVIDER_LABELS[urlState.issued.provider] ?? urlState.issued.provider} setup line`} />
                      <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>{KEY_HEADER_LINE}</span>
                    </>
                  )}
                  <AgentNaming />
                </>
              ) : tab === 'aws' ? (
                <>
                  <UrlHint urlState={urlState} />
                  <ClientSetup urlState={urlState}><BedrockSteps urlState={urlState} /></ClientSetup>
                  {urlState.kind === 'issued' && <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>{KEY_HEADER_LINE}</span>}
                  {urlState.kind === 'issued' && <AgentNaming {...agentNamingFor(urlState.issued.provider)} />}
                </>
              ) : (
                <>
                  <UrlHint urlState={urlState} />
                  <ClientSetup urlState={urlState}>
                    <RecipeStep label={proxyUrlStepLabel(urlState)} code={withProxyUrl(`export AZURE_OPENAI_ENDPOINT=${PROXY_KEY_URL}`, PROXY_KEY_URL, urlState)} />
                    <RecipeStep label="Your Azure API key stays the same" code="export AZURE_OPENAI_API_KEY=<your-azure-api-key>" />
                    <RecipeStep label="The AzureOpenAI client picks both up; nothing else changes" code={`from openai import AzureOpenAI\n\nclient = AzureOpenAI(\n    api_version="2024-10-21",  # your usual api-version\n    ${AGENT_PY_HEADERS},  # optional if your agent has a system prompt\n)\nclient.chat.completions.create(\n    model="<your-deployment-name>",\n    messages=[{"role": "user", "content": "Hello"}],\n)`} />
                    <RecipeStep label="Or with the OpenAI SDK against Azure's v1 API" code={withProxyUrl(`from openai import OpenAI\n\nclient = OpenAI(\n    base_url="${PROXY_KEY_URL}/openai/v1",\n    api_key="<your-azure-api-key>",\n    ${AGENT_PY_HEADERS},  # optional if your agent has a system prompt\n)`, PROXY_KEY_URL, urlState)} />
                  </ClientSetup>
                  {urlState.kind === 'issued' && <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>{KEY_HEADER_LINE}</span>}
                  {urlState.kind === 'issued' && <AgentNaming {...agentNamingFor(urlState.issued.provider)} />}
                </>
              )}
              <ConnectCaveat caveat={caveat} />
            </div>
          </SettingsCard>

          {!rotated && roleMode && <BedrockRoleCard apiKey={apiKey} fleetId={fleetId} fleetToken={fleetToken} />}

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

          <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--tx2)', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <a href={SETUP_GUIDE_URL} className="wr-link">Setup guide</a>
            <a href="https://whiteroom.tech/openapi.yaml" className="wr-link">OpenAPI</a>
            <a href={ROUTES.sandbox} className="wr-link">Test in Sandbox &rarr;</a>
          </p>
          </div>
        </div>
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

/** "Provider keys below" as a link to its card; plain words after a rotation, when the cards are hidden until the reload. */
function Below({ to, children, linked = true }: { to: string; children: React.ReactNode; linked?: boolean }) {
  return linked ? <a href={`#${to}`} className="wr-link">{children}</a> : <>{children}</>;
}

/** The step that sets the proxy URL: once it's filled in, the label no longer says where it will appear. */
function proxyUrlStepLabel(urlState: ProxyUrlState): string {
  return urlState.kind === 'issued' ? 'Set your proxy URL' : 'Set your proxy URL (shown when you connect your key)';
}

/**
 * Where a tab's proxy URL is, once a key is connected: in the line under
 * this (just issued), or shown once and gone.
 */
function UrlHint({ urlState }: { urlState: ProxyUrlState }) {
  if (urlState.kind === 'none') return null;
  if (urlState.kind === 'issued') {
    return <Banner variant="info" icon="check">Key ending {urlState.issued.keyHint} connected. Set this where your agent runs. It&rsquo;s shown once, so copy it now.</Banner>;
  }
  return (
    <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>
      {urlState.keyHint ? <>The proxy URL for your key ending {urlState.keyHint} was shown once, when you added it. Lost it?</> : <>Each key&rsquo;s proxy URL was shown once, when you added it. Lost one?</>}
      {' '}Choose Replace URLs under <Below to="provider-keys">Provider keys</Below>.
    </p>
  );
}

/** Claude on AWS Bedrock: the Anthropic SDK, pointed at the proxy URL with the Bedrock API key. What to connect, above Provider keys. */
function BedrockLead({ linked }: { linked: boolean }) {
  return (
    <>
      <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>
        Add your Bedrock API key and the region your Claude models run in under <Below to="provider-keys" linked={linked}>Provider keys below</Below>. You get back a proxy URL: point the Anthropic SDK at it instead of Bedrock and keep your Bedrock API key.
      </p>
      <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>
        <li>{BEDROCK_NOTES.key}</li>
        <li>{BEDROCK_NOTES.region}</li>
        <li>{BEDROCK_NOTES.custody}</li>
        <li>{BEDROCK_NOTES.model}</li>
      </ul>
    </>
  );
}

/** The Bedrock client lines, under Provider keys. */
function BedrockSteps({ urlState }: { urlState: ProxyUrlState }) {
  const [lang, setLang] = useState<Lang>('python');
  return (
    <>
      <RecipeStep label={proxyUrlStepLabel(urlState)} code={withProxyUrl(BEDROCK_LINES.baseUrl, PROXY_KEY_URL, urlState)} />
      <RecipeStep label={`Use your Bedrock API key (${BEDROCK_KEY_ENV}) as the API key`} code={BEDROCK_LINES.apiKey} />
      <div style={{ display: 'grid', gap: 6 }}>
        <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>Or set both on the client</span>
        <SegmentedControl<Lang> label="Language" value={lang} onChange={setLang} options={LANGS} size={24} />
        <CopyChip text={withProxyUrl(BEDROCK_LINES[lang], PROXY_KEY_URL, urlState)} label={`Copy the Bedrock ${lang === 'python' ? 'Python' : 'TypeScript'} client`} />
      </div>
    </>
  );
}

/**
 * A cloud tab's client lines. Open, with the real URL in them, just after a
 * key is connected; otherwise folded away, since all they can show is a
 * placeholder where the URL goes. One wrapper either way, so what's inside
 * (the language picked) isn't remounted when a key connects.
 */
function ClientSetup({ urlState, children }: { urlState: ProxyUrlState; children: React.ReactNode }) {
  return (
    <details open={urlState.kind === 'issued'} style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>
      <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Client setup</summary>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 14, marginTop: 10 }}>{children}</div>
    </details>
  );
}

/**
 * Native Bedrock Runtime, any model: your agent keeps its own AWS
 * credentials. WhiteRoom proves who's calling by replaying a signed
 * sts:GetCallerIdentity, never a bearer key — there's nothing to paste into
 * the client beyond the SDK install below.
 */
function BedrockRoleRecipe({ linked }: { linked: boolean }) {
  return (
    <>
      <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>
        Create an IAM role in your AWS account that trusts WhiteRoom, then connect it under <Below to="bedrock-role" linked={linked}>Cross-account role below</Below>. No API key — your agent authenticates with its own AWS credentials; WhiteRoom verifies the call and assumes this role to reach Bedrock on its behalf.
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
