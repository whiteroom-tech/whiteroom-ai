// Agent identity in words (gap-closing spec 0.2): how a call was keyed and
// how its agent's name was known, for the Runs and Agent pages. Also the
// display-name rules the engine applies (agent_rename), so the form can say
// what's wrong before sending.

// signed_name and signature_invalid come with signed agent names; `other` is
// how this build shows a value from a newer engine, so it never reads "undefined".
export const IDENTITY_CREDENTIALS = ['bound_key', 'signed_name', 'fleet_key', 'signature_invalid', 'none', 'session', 'not_recorded', 'other'] as const;
export const IDENTITY_NAME_SOURCES = ['explicit', 'inferred', 'unresolved'] as const;
/** What "One key per agent" counts as unbound. signed_name counts as bound, like bound_key. */
export const UNBOUND_CREDENTIALS = ['fleet_key', 'signature_invalid', 'none', 'session', 'not_recorded', 'other'] as const;
export type IdentityCredential = (typeof IDENTITY_CREDENTIALS)[number];
export type IdentityNameSource = (typeof IDENTITY_NAME_SOURCES)[number];
export type UnboundCredential = (typeof UNBOUND_CREDENTIALS)[number];

export interface IdentityMixRow {
  credential: IdentityCredential;
  nameSource: IdentityNameSource;
  calls: number;
  lastAt: string | null;
}

const KEY_WORDS: Record<'fleet_key' | 'none' | 'session', string> = {
  fleet_key: 'Shared key',
  none: 'Provider key',
  session: 'AWS session',
};

/** Words that don't change with how the name was found. */
const WHOLE_WORDS: Partial<Record<IdentityCredential, string>> = {
  not_recorded: 'Not recorded',
  signed_name: 'Signed by your gateway',
  signature_invalid: "Gateway signature didn't match",
  other: 'Other',
};

/** The 0.2 words for one credential and name source. */
export function identityWords(credential: IdentityCredential, nameSource: IdentityNameSource): string {
  const whole = WHOLE_WORDS[credential];
  if (whole) return whole;
  if (nameSource === 'unresolved') return 'Not known';
  if (credential === 'bound_key') return 'Own key';
  return `${KEY_WORDS[credential as keyof typeof KEY_WORDS]}, name ${nameSource === 'explicit' ? 'sent by the agent' : 'worked out by WhiteRoom'}`;
}

export interface IdentityLine {
  words: string;
  calls: number;
  /** Share of the total, whole percent; 0 shows as "<1%" when it has calls. */
  percent: number;
}

/**
 * Rows as lines, most calls first, the same words merged (an own-key call's
 * name source doesn't change its words). Empty with no calls.
 */
export function identityLines(rows: readonly IdentityMixRow[]): IdentityLine[] {
  const total = rows.reduce((s, r) => s + r.calls, 0);
  if (total === 0) return [];
  const merged = new Map<string, number>();
  for (const r of rows) {
    const words = identityWords(r.credential, r.nameSource);
    merged.set(words, (merged.get(words) ?? 0) + r.calls);
  }
  return [...merged]
    .map(([words, calls]) => ({ words, calls, percent: Math.floor((calls / total) * 100) }))
    .sort((a, b) => b.calls - a.calls || a.words.localeCompare(b.words));
}

/** "<1%" for a small share that still has calls. */
export const percentText = (l: IdentityLine) => (l.percent === 0 ? '<1%' : `${l.percent}%`);

// -- Display names --

/** The engine's limit (agent_rename). */
export const MAX_AGENT_NAME = 60;

/** The name as the engine stores it, or why it can't be one. Empty means clear. */
export function cleanAgentName(raw: string): { name: string | null } | { error: string } {
  const name = raw.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (!name) return { name: null };
  if (/[\p{Cc}\p{Cf}]/u.test(name)) return { error: 'Use letters, numbers, spaces and punctuation only.' };
  if ([...name].length > MAX_AGENT_NAME) return { error: `Keep it to ${MAX_AGENT_NAME} characters.` };
  return { name };
}

/** How a list shows an agent: its name with the id beside it, or the id alone. */
export function agentDisplay(agentId: string, names: Readonly<Record<string, string>> | null | undefined): { name: string | null; id: string } {
  const name = names?.[agentId];
  return { name: name && name !== agentId ? name : null, id: agentId };
}

// -- One key per agent --

export type AgentKeyMode = 'off' | 'watch' | 'enforce';
export const AGENT_KEY_MODES: readonly AgentKeyMode[] = ['off', 'watch', 'enforce'];

export interface AgentKeyAgentRow {
  agentId: string;
  boundCalls: number;
  unboundCalls: number;
  unboundCredentials: UnboundCredential[];
  lastUnboundAt: string | null;
}

export interface AgentKeySummary {
  from: string;
  to: string;
  recorded: boolean;
  unboundCalls: number;
  byCredential: Partial<Record<UnboundCredential, number>>;
  agents: AgentKeyAgentRow[];
  truncated: boolean;
}

export interface AgentKeyRuleResult {
  applies: boolean;
  mode: AgentKeyMode;
  since: string | null;
  summary: AgentKeySummary | null;
}

/** What keeps Enforce closed (engine agent_key_readiness, spec A4). */
export type ReadinessBlocker =
  | { kind: 'not_applicable' }
  | { kind: 'not_recorded' }
  | { kind: 'not_watching' }
  | { kind: 'watch_too_short'; readyAt: string }
  | { kind: 'unbound_calls'; calls: number }
  | { kind: 'capture_gaps'; gaps: number; lastAt: string | null }
  | { kind: 'agents_not_seen'; agentIds: string[] };

export interface ReadinessAgent {
  agentId: string;
  boundCalls: number;
  unboundCalls: number;
  lastBoundAt: string | null;
  expectedBecause: 'registered' | 'recent_calls';
}

export interface AgentKeyReadiness {
  ready: boolean;
  mode: AgentKeyMode;
  from: string | null;
  to: string;
  observationDays: number;
  blockers: ReadinessBlocker[];
  agents: ReadinessAgent[];
  retired: Array<{ agentId: string; retiredAt: string; retiredBy: string | null }>;
  truncated: boolean;
  /** Sent back when switching Enforce on: the engine refuses it if anything changed since. */
  token: string;
}

/** "Shared key", "Provider key", "AWS session", "Not recorded" and so on: what an unbound call came in on. */
export function credentialWords(c: UnboundCredential): string {
  return WHOLE_WORDS[c] ?? KEY_WORDS[c as keyof typeof KEY_WORDS];
}
