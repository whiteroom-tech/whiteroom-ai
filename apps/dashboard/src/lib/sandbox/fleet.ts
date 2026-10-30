// Sandbox v2 (spec sandbox-v2 §2 steps 1–2, §3): the production fleet's
// lasting Sandbox fleet. The browser talks to /api/sandbox/fleet/<action>,
// which checks the signed-in user owns the production fleet and calls the
// engine's dashboard-only sandbox_fleet_* actions.
//
// Pure parts (types, parsing, the connect check, wording) are shared with the
// BFF, so the browser and the server agree on what a valid request and a
// valid answer look like. A Sandbox key (sk-wr-…) is shown once: it lives in
// page state only, never in storage, logs or the status answer.

import { fmtDay, timeAgo } from '@/lib/format';
import { issuedEnvHint } from '@/lib/provider-key-form';
import { cloudStart, isCloudProvider, isSandboxProvider, SANDBOX_PROVIDER_LABELS, type SandboxProvider } from './providers';

export const SANDBOX_FLEET_ACTIONS = ['status', 'connect', 'rotate', 'reset'] as const;
export type SandboxFleetAction = (typeof SANDBOX_FLEET_ACTIONS)[number];

export function isSandboxFleetAction(v: unknown): v is SandboxFleetAction {
  return typeof v === 'string' && (SANDBOX_FLEET_ACTIONS as readonly string[]).includes(v);
}

/** The Sandbox's provider key, as the engine describes it: never the key, only its last 4. */
export interface SandboxFleetKey {
  /** The Sandbox key's display prefix, "sk-wr-<16 hex>...". */
  prefix: string;
  provider: string;
  keyHint: string;
  endpoint?: string;
}

export type SandboxFleetStatus =
  | { exists: false }
  | {
    exists: true;
    sandboxFleetId: string;
    createdAt: string;
    lastCallAt: string | null;
    expiresAt: string | null;
    key: SandboxFleetKey | null;
    /** Calls in the last day that came outside a check (spec §8.3): a forgotten agent. */
    callsOutsideWindow24h?: number;
    lastCallOutsideWindowAt?: string | null;
  };

/** A Sandbox key handed out by connect or rotate. Shown once; never stored. */
export interface IssuedSandboxKey {
  proxyKey: string;
  proxyUrl: string;
  provider: string;
  keyHint: string | null;
}

/** The engine has no Sandbox v2 yet (an older engine, or the secret isn't set). */
export const SANDBOX_FLEET_UNAVAILABLE = 'sandbox_fleet_unavailable';

export class SandboxFleetError extends Error {
  /** `retryAfter`: seconds to wait, from a 429. */
  constructor(message: string, readonly status: number, readonly reason?: string, readonly retryAfter?: number) {
    super(message);
    this.name = 'SandboxFleetError';
  }
}

export const isUnavailable = (e: unknown) => e instanceof SandboxFleetError && e.reason === SANDBOX_FLEET_UNAVAILABLE;

/**
 * The reason the BFF gives the engine's pin refusal (the page's
 * `sandboxFleetId` isn't the fleet's Sandbox any more). The engine sends it as
 * reason sandbox_changed (older engines sent only its fixed text); every other
 * 409 is a state conflict (a check already running, none running, nothing stopped…).
 */
export const SANDBOX_CHANGED = 'sandbox_changed';
/** The engine's pin refusal by its text: a fallback for engines that sent it without reason sandbox_changed. */
export const isPinMismatch = (status: number, error: string) => status === 409 && /^That Sandbox doesn['’]t belong to this fleet\.?$/.test(error);

/**
 * The Sandbox changed under the page: gone (404), or not the one the page
 * pinned (409 sandbox_changed). A state-conflict 409 is not stale.
 */
export const isStaleSandbox = (e: unknown) =>
  e instanceof SandboxFleetError && (e.status === 404 || (e.status === 409 && e.reason === SANDBOX_CHANGED));

const str = (v: unknown, max = 512): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const strOrNull = (v: unknown): string | null => (str(v) ? v : null);
/** The display prefix only: a full key here would be a leak, so anything longer is dropped. */
const KEY_PREFIX_RE = /^sk-wr-[0-9a-f]{4,32}\.{0,3}$/;

/**
 * The status fields of an engine answer, and nothing else. Null when the
 * answer isn't a status (no `exists`), so a stray or unexpected reply is never
 * shown as "no Sandbox".
 */
export function statusOf(data: unknown): SandboxFleetStatus | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (d.exists === false) return { exists: false };
  if (d.exists !== true || !str(d.sandboxFleetId, 128) || !str(d.createdAt, 64)) return null;
  let key: SandboxFleetKey | null = null;
  const k = d.key as Record<string, unknown> | null | undefined;
  if (k && typeof k === 'object' && str(k.prefix, 64) && KEY_PREFIX_RE.test(k.prefix) && str(k.provider, 64) && str(k.keyHint, 8)) {
    key = { prefix: k.prefix, provider: k.provider, keyHint: k.keyHint, ...(str(k.endpoint) && { endpoint: k.endpoint }) };
  }
  return {
    exists: true,
    sandboxFleetId: d.sandboxFleetId,
    createdAt: d.createdAt,
    lastCallAt: strOrNull(d.lastCallAt),
    expiresAt: strOrNull(d.expiresAt),
    key,
    ...(typeof d.callsOutsideWindow24h === 'number' && Number.isInteger(d.callsOutsideWindow24h) && d.callsOutsideWindow24h >= 0 && {
      callsOutsideWindow24h: d.callsOutsideWindow24h,
      lastCallOutsideWindowAt: strOrNull(d.lastCallOutsideWindowAt),
    }),
  };
}

/** The Sandbox card's notice when an agent called outside a check (spec §8.3), or null. */
export function outsideWindowText(status: SandboxFleetStatus): string | null {
  const n = status.exists ? status.callsOutsideWindow24h ?? 0 : 0;
  if (n <= 0) return null;
  return `Your agent called the Sandbox ${n === 1 ? 'once' : `${n.toLocaleString('en-US')} times`} outside a check in the last day. Sandbox rules only watch then, so nothing was blocked.`;
}

/** The once-shown key of a connect or rotate answer, or null when there isn't one. */
export function issuedOf(data: unknown, fallback?: { provider?: string; keyHint?: string | null }): IssuedSandboxKey | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (!str(d.proxyKey, 128) || !d.proxyKey.startsWith('sk-wr-') || !str(d.proxyUrl, 512)) return null;
  const status = statusOf(d);
  const provider = str(d.provider, 64) ? d.provider : status?.exists && status.key ? status.key.provider : fallback?.provider ?? 'anthropic';
  const keyHint = str(d.keyHint, 8) ? d.keyHint : status?.exists && status.key ? status.key.keyHint : fallback?.keyHint ?? null;
  return { proxyKey: d.proxyKey, proxyUrl: d.proxyUrl, provider, keyHint };
}

export type ConnectCheck =
  | { ok: true; request: { api_key: string; provider: SandboxProvider; endpoint?: string } }
  | { ok: false; error: string };

/**
 * What Connect may send: the agent's provider key for the chosen provider,
 * and the endpoint a cloud provider needs. Checked in the browser and again
 * in the BFF, so a WhiteRoom key or a mismatched one never reaches the engine.
 */
export function connectCheck(provider: unknown, rawKey: unknown, rawEndpoint?: unknown): ConnectCheck {
  if (!isSandboxProvider(provider)) return { ok: false, error: 'Pick where your agent’s model runs.' };
  const key = typeof rawKey === 'string' ? rawKey.trim() : '';
  if (!key) return { ok: false, error: 'Paste the key your agent uses.' };
  if (key.startsWith('sk-wr-') || key.startsWith('wr_')) return { ok: false, error: 'That’s a WhiteRoom key. Paste the key your agent uses with its provider.' };
  if (key.length < 8 || key.length > 512 || /\s/.test(key)) return { ok: false, error: 'That doesn’t look like a provider key. Check it and paste it again.' };
  if (provider === 'anthropic' && !key.startsWith('sk-ant-')) {
    return { ok: false, error: key.startsWith('sk-') ? 'That looks like an OpenAI key. Pick OpenAI above.' : 'Anthropic keys start with sk-ant-.' };
  }
  if (provider === 'openai') {
    if (key.startsWith('sk-ant-')) return { ok: false, error: 'That looks like an Anthropic key. Pick Anthropic above.' };
    if (!key.startsWith('sk-')) return { ok: false, error: 'OpenAI keys start with sk-.' };
  }
  if (!isCloudProvider(provider)) return { ok: true, request: { api_key: key, provider } };
  const target = cloudStart(provider, typeof rawEndpoint === 'string' ? rawEndpoint : '');
  if (!target.ok) return { ok: false, error: target.error };
  return { ok: true, request: { api_key: key, provider, endpoint: target.endpoint } };
}

/** The line that points an agent at the Sandbox: the same shape as production's (Fleet key). */
export function pointLine(provider: string, proxyUrl: string): string {
  return issuedEnvHint(provider, proxyUrl.replace(/\/+$/, ''));
}

/** The one setting that points an agent at the Sandbox: its name and value, as pointLine sets it. */
export function sandboxSetting(provider: string, proxyUrl: string): { name: string; value: string } {
  const line = pointLine(provider, proxyUrl).replace(/^export /, '');
  const at = line.indexOf('=');
  return { name: line.slice(0, at), value: line.slice(at + 1) };
}

export function providerLabel(provider: string): string {
  return isSandboxProvider(provider) ? SANDBOX_PROVIDER_LABELS[provider] : provider;
}

/** "No calls yet", or "5 min ago". */
export function lastCallText(lastCallAt: string | null, now = Date.now()): string {
  return lastCallAt ? timeAgo(lastCallAt, now) || 'No calls yet' : 'No calls yet';
}

/** "Kept until Nov 12 — renewed each time your agent calls". */
export function keptUntilText(expiresAt: string | null, now = Date.now()): string {
  const day = expiresAt ? fmtDay(expiresAt, now) : '';
  // 7 days: the engine keeps a Sandbox 7 days after its last call (engine #317).
  return day ? `Kept until ${day} — renewed each time your agent calls` : 'Kept for 7 days after your agent’s last call';
}

// ── Browser calls (through the BFF) ──

/** POSTs to a Sandbox BFF route (`/api/sandbox/...`); its refusal as a SandboxFleetError. */
export async function sandboxPost(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new SandboxFleetError('Couldn’t reach WhiteRoom. Check your connection and try again.', 0);
  }
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !data) {
    const message = data && typeof data.error === 'string' ? data.error : 'That didn’t work. Try again.';
    const wait = data && typeof data.retryAfter === 'number' ? data.retryAfter : undefined;
    throw new SandboxFleetError(message, res.status, data && typeof data.reason === 'string' ? data.reason : undefined, wait);
  }
  return data;
}

const call = (action: SandboxFleetAction, body: Record<string, unknown>) => sandboxPost(`/api/sandbox/fleet/${action}`, body);

function mustStatus(data: unknown): SandboxFleetStatus {
  const status = statusOf(data);
  // An unreadable answer is an error with Try again, never "no Sandbox v2 here" (only the BFF's explicit answer is that).
  if (!status) throw new SandboxFleetError('WhiteRoom sent an answer the dashboard couldn’t read. Try again.', 502);
  return status;
}

export async function getSandboxFleetStatus(fleet: string): Promise<SandboxFleetStatus> {
  return mustStatus(await call('status', { fleet }));
}

export async function connectSandboxFleet(fleet: string, request: { api_key: string; provider: SandboxProvider; endpoint?: string }): Promise<{ status: SandboxFleetStatus; issued: IssuedSandboxKey }> {
  const data = await call('connect', { fleet, ...request });
  const issued = issuedOf(data, { provider: request.provider, keyHint: request.api_key.slice(-4) });
  if (!issued) throw new SandboxFleetError('WhiteRoom didn’t send your Sandbox key. Try again.', 502);
  return { status: mustStatus(data), issued };
}

export async function rotateSandboxFleetKey(fleet: string, sandboxFleetId?: string): Promise<{ status: SandboxFleetStatus; issued: IssuedSandboxKey }> {
  const data = await call('rotate', { fleet, ...(sandboxFleetId && { sandboxFleetId }) });
  const issued = issuedOf(data);
  if (!issued) throw new SandboxFleetError('WhiteRoom didn’t send your new Sandbox key. Try again.', 502);
  return { status: mustStatus(data), issued };
}

export async function resetSandboxFleet(fleet: string, sandboxFleetId?: string): Promise<SandboxFleetStatus> {
  return mustStatus(await call('reset', { fleet, ...(sandboxFleetId && { sandboxFleetId }) }));
}
