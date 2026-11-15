'use client';

import { AppShell } from '@/components/AppShell';
import { FleetAuthProvider } from '@/hooks/useFleetAuth';
import ControlsPage from '@/app/(citadel)/controls/page';
import type { GovernanceRule } from '@/lib/whiteroom/types';
import { newMarker } from '@/lib/controls-view';

// The engine and session, stood in for in the browser (installed before the
// page's first request). Shaped like the demo fleet in the mockup: one rule
// blocking, two overlapping spend caps, two identical loop breakers, an
// allowlist missing a model one agent uses, a Keywords rule (with a marker) for one agent,
// and a Tool list with nothing picked. ?state=empty (no rules), ?state=fail
// (the rules can't be read) and ?state=loading show the other states;
// ?state=unknown adds a rule of a type this build doesn't know.
// Where tools can send data (send_limit): ?state=send adds one in Watch with
// a Seen list (reserved and cleaned rows among them) and one in Enforce with
// an empty list and a tool that sends no domain; ?state=send-cap fills Seen
// to its 500 cap; ?state=send-hidden is a reader without the dashboard's
// secret (domainCount, no Seen list); ?state=send-old is an engine that
// doesn't take send_limit (Add a rule leaves it out).
// Outside content, then send data (outside_then_send): ?state=flow adds one in
// Watch for all agents, one alerting in Enforce for support-triage, and one
// with no send tools (Not set up); ?state=flow-old is an engine that doesn't
// take outside_then_send (Add a rule leaves it out).
// Repeated blocks (block_streak) and Old tool results (trim_results) are always
// there: one pausing in Watch, one trimming in Enforce for market-researcher.
const state = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('state') : null;
const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const base = { fleetId: 'acme-claims-prod', changedBy: 'preview', changedAt: day(2) };
let version = 1;
let rules: GovernanceRule[] = state === 'empty' ? [] : [
  { ...base, id: 'r1', version: 1, ruleType: 'loop_breaker', mode: 'enforce', response: 'block', appliesTo: 'all', params: { threshold: 100, scope: 'run', ignoreTools: [] } },
  { ...base, id: 'r4', version: 1, ruleType: 'spend_cap', mode: 'watch', response: 'block', appliesTo: 'all', params: { dailyCap: 190, scope: 'day', unit: 'dollars' } },
  { ...base, id: 'r3', version: 1, ruleType: 'spend_cap', mode: 'watch', response: 'block', appliesTo: 'all', params: { dailyCap: 200, scope: 'day', unit: 'dollars' } },
  { ...base, id: 'r8', version: 1, ruleType: 'spend_cap', mode: 'watch', response: 'block', appliesTo: 'all', params: { dailyCap: 50000, scope: 'run', unit: 'tokens' } },
  { ...base, id: 'r2', version: 1, ruleType: 'model_allowlist', mode: 'watch', response: 'block', appliesTo: 'all', params: { allowedModels: ['claude-haiku-4-5'] } },
  { ...base, id: 'r9', version: 1, ruleType: 'loop_breaker', mode: 'watch', response: 'block', appliesTo: 'all', params: { threshold: 5, scope: 'run', ignoreTools: [] } },
  { ...base, id: 'r10', version: 1, ruleType: 'loop_breaker', mode: 'watch', response: 'block', appliesTo: 'all', params: { threshold: 5, scope: 'run', ignoreTools: [] } },
  { ...base, id: 'r5', version: 1, ruleType: 'keyword', mode: 'watch', response: 'block', appliesTo: ['lead-agent'], params: { keywords: ['password', newMarker()], where: 'incoming', wholeWord: true } },
  { ...base, id: 'r6', version: 1, ruleType: 'call_rate', mode: 'off', response: 'block', appliesTo: ['lead-agent'], params: { maxCalls: 60 } },
  { ...base, id: 'r7', version: 1, ruleType: 'tool_list', mode: 'off', response: 'block', appliesTo: 'all', params: { blockedTools: [] } },
  { ...base, id: 'b1', version: 1, ruleType: 'block_streak', mode: 'watch', response: 'pause', appliesTo: 'all', params: { threshold: 3 } },
  { ...base, id: 't1', version: 1, ruleType: 'trim_results', mode: 'enforce', response: 'notify', appliesTo: ['market-researcher'], params: { keepRecent: 5, minTokens: 50_000 } },
  ...(state?.startsWith('send') ? sendRules() : []),
  ...(state === 'flow' ? flowRules() : []),
  ...(state === 'unknown' ? [{ ...base, id: 'r12', version: 1, ruleType: 'made_up_type', mode: 'enforce', response: 'block', appliesTo: 'all', params: {} } as unknown as GovernanceRule] : []),
];
function sendRules(): GovernanceRule[] {
  const hidden = state === 'send-hidden';
  return [
    { ...base, id: 's1', version: 1, ruleType: 'send_limit', mode: 'watch', response: 'notify', appliesTo: 'all',
      params: hidden ? { tools: ['send_email', 'http_request'], domains: [], domainCount: 3 } : { tools: ['send_email', 'http_request'], domains: ['acme.com'] } },
    ...(hidden ? [] : [{ ...base, id: 's2', version: 1, ruleType: 'send_limit', mode: 'enforce', response: 'block', appliesTo: ['support-triage'],
      params: { tools: ['post_message', 'send_email'], domains: [] } } as GovernanceRule]),
  ];
}
function flowRules(): GovernanceRule[] {
  return [
    { ...base, id: 'f1', version: 1, ruleType: 'outside_then_send', mode: 'watch', response: 'notify', appliesTo: 'all',
      params: { readTools: ['web_fetch', 'read_inbox'], sendTools: ['send_email', 'post_message', 'http_request'] } },
    { ...base, id: 'f2', version: 1, ruleType: 'outside_then_send', mode: 'enforce', response: 'notify', appliesTo: ['support-triage'],
      params: { readTools: ['read_inbox'], sendTools: ['send_email'] } },
    { ...base, id: 'f3', version: 1, ruleType: 'outside_then_send', mode: 'watch', response: 'notify', appliesTo: ['ops-scheduler'],
      params: { readTools: ['web_fetch'], sendTools: [] } },
  ];
}
const SEEN: Record<string, { tool: string; domain: string; agentId: string; firstSeen: string; canAdd?: boolean }[]> = {
  s1: state === 'send-cap'
    ? Array.from({ length: 500 }, (_, i) => ({ tool: 'http_request', domain: `vendor-${String(i + 1).padStart(3, '0')}.com`, agentId: 'support-triage', firstSeen: day(1 + (i % 9)) }))
    : [
      { tool: 'send_email', domain: 'gmail.com', agentId: 'support-triage', firstSeen: day(3) },
      { tool: 'http_request', domain: 'sendgrid.net', agentId: 'support-triage', firstSeen: day(5) },
      { tool: 'http_request', domain: '(unreadable)', agentId: 'ops-scheduler', firstSeen: day(4) },
      { tool: 'send_email', domain: 'mail-[removed].example', agentId: 'support-triage', firstSeen: day(2), canAdd: false },
    ],
  s2: [{ tool: 'post_message', domain: '(none)', agentId: 'support-triage', firstSeen: day(1) }],
};
const RULE_TYPES = ['spend_cap', 'loop_breaker', 'model_allowlist', 'tool_list', 'call_rate', 'keyword', ...(state === 'send-old' ? [] : ['send_limit']), ...(state === 'flow-old' ? [] : ['outside_then_send']), 'block_streak', 'trim_results'];
const AGENTS = ['code-reviewer', 'contract-summarizer', 'invoice-reconciler', 'lead-agent', 'market-researcher', 'ops-scheduler', 'support-triage'];
const history = state === 'empty' ? [] : [
  { id: 'h5', ruleId: 'r10', ruleType: 'loop_breaker', description: 'Added new Loop breaker rule', by: 'user:u1', time: new Date(Date.now() - 40 * 60_000).toISOString() },
  { id: 'h1', ruleId: 'r1', ruleType: 'loop_breaker', description: 'Off → Enforce', by: 'user:u1', time: day(1),
    before: { mode: 'off', response: 'block', alsoNotify: false, appliesTo: 'all', params: { threshold: 100, scope: 'run', ignoreTools: [] } },
    after: { mode: 'enforce', response: 'block', alsoNotify: false, appliesTo: 'all', params: { threshold: 100, scope: 'run', ignoreTools: [] } } },
  { id: 'h2', ruleId: 'r3', ruleType: 'spend_cap', description: 'Settings updated', by: 'user:u1', time: day(2),
    before: { mode: 'watch', response: 'block', alsoNotify: false, appliesTo: 'all', params: { dailyCap: 250, scope: 'day', unit: 'dollars' } },
    after: { mode: 'watch', response: 'block', alsoNotify: false, appliesTo: 'all', params: { dailyCap: 200, scope: 'day', unit: 'dollars' } } },
  { id: 'h4', ruleId: 'r11', ruleType: 'spend_cap', description: 'Removed Spend cap rule', by: 'user:u1', time: day(3),
    before: { mode: 'enforce', response: 'block', alsoNotify: false, appliesTo: ['code-reviewer'], params: { dailyCap: 20, scope: 'day', unit: 'dollars' } }, after: null },
  { id: 'h3', ruleId: 'r5', ruleType: 'keyword', description: 'Added new Keywords rule', by: 'user:u1', time: day(3) },
];
const counts = (n: Partial<Record<'blocked' | 'paused' | 'stopped' | 'toldYou' | 'wouldAct' | 'trimmed', number>>) => ({ blocked: 0, paused: 0, stopped: 0, toldYou: 0, wouldAct: 0, ...n });

function engine(body: Record<string, unknown>): unknown {
  switch (body.action) {
    case 'governance_list': if (state === 'fail') throw new Error('down'); return { fleetId: base.fleetId, rules, history, agents: AGENTS, govV1: true, ruleTypes: RULE_TYPES };
    case 'governance_create_rule': {
      const type = body.rule_type as GovernanceRule['ruleType'];
      const defaults: Record<string, GovernanceRule['params']> = {
        spend_cap: { dailyCap: 50, scope: 'day', unit: 'dollars' }, loop_breaker: { threshold: 100, scope: 'run', ignoreTools: [] },
        model_allowlist: { allowedModels: [] }, tool_list: { blockedTools: [] }, call_rate: { maxCalls: 60 }, keyword: { keywords: [], where: 'incoming', wholeWord: true },
        send_limit: { tools: [], domains: [] }, outside_then_send: { readTools: [], sendTools: [] },
        block_streak: { threshold: 3 }, trim_results: { keepRecent: 5, minTokens: 50_000 },
      };
      const rule = { ...base, changedAt: new Date().toISOString(), id: `n${++version}`, version: 1, ruleType: type, mode: 'watch', response: (body.response as GovernanceRule['response']) ?? (type === 'outside_then_send' ? 'notify' : 'block'), appliesTo: (body.applies_to as GovernanceRule['appliesTo']) ?? 'all', params: (body.params as GovernanceRule['params']) ?? defaults[type] } as GovernanceRule;
      rules = [...rules, rule];
      return { rule };
    }
    case 'governance_update_rule': {
      const prev = rules.find((r) => r.id === body.rule_id)!;
      const next = { ...prev, version: prev.version + 1, changedAt: new Date().toISOString(),
        ...(body.mode !== undefined && { mode: body.mode }), ...(body.response !== undefined && { response: body.response }),
        ...(body.also_notify !== undefined && { alsoNotify: body.also_notify }), ...(body.params !== undefined && { params: body.params }),
        ...(body.applies_to !== undefined && { appliesTo: body.applies_to }) } as GovernanceRule;
      rules = rules.map((r) => (r.id === prev.id ? next : r));
      return { rule: next };
    }
    case 'governance_delete_rule': rules = rules.filter((r) => r.id !== body.rule_id); return { success: true };
    // The fleet's own tools for the pickers; with ?state=empty the read fails, as on an older engine.
    case 'send_seen_list': if (state === 'send-hidden') throw new Error('Only this fleet’s owner can read this.');
      return { ruleId: body.rule_id, rows: SEEN[String(body.rule_id)] ?? [], full: state === 'send-cap' && body.rule_id === 's1' };
    case 'tools_seen': if (state === 'empty') throw new Error('Unknown action'); return { tools: ['search_claims', 'update_claim', 'delete_attachment', 'send_email', 'read_file', ...(state?.startsWith('send') || state?.startsWith('flow') ? ['post_message', 'http_request'] : []), ...(state?.startsWith('flow') ? ['web_fetch', 'read_inbox'] : [])] };
    case 'rule_would_act': return { fleetId: base.fleetId, ruleId: body.rule_id, byAgent: body.rule_id === 'r2' ? { 'code-reviewer': 44 } : {}, unversioned: false, since: day(4) };
    // Sample counts: the allowlist caught 60 calls from code-reviewer; one loop breaker caught 12 from lead-agent.
    case 'rule_actions': return { fleetId: base.fleetId, totals: counts({ wouldAct: 72, trimmed: 38 }), byAgent: { 'code-reviewer': counts({ wouldAct: 60 }), 'lead-agent': counts({ wouldAct: 12 }), 'market-researcher': counts({ trimmed: 38 }) },
      byRule: { model_allowlist: counts({ wouldAct: 60 }), loop_breaker: counts({ wouldAct: 12 }), trim_results: counts({ trimmed: 38 }) }, byRuleId: { r2: counts({ wouldAct: 60 }), r9: counts({ wouldAct: 12 }), t1: counts({ trimmed: 38 }) } };
    case 'performance_agent': return { fleetId: base.fleetId, agentId: body.agent_id, hourly: [{ hour: day(10), calls: 60, costMicros: 31_000_000 }], totals: { calls: body.agent_id === 'code-reviewer' ? 44 : 120, costMicros: 31_000_000, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, errorRate: 0, avgLatencyMs: null } };
    case 'audit_integrity': return { fleetId: base.fleetId, mode: 'sequenced', headSeq: 2045, verifiedThroughSeq: 2045, verifiedAt: new Date().toISOString(), prunedBeforeTracking: true, legacyEvents: 0, gaps: { count: 0, recent: [] }, anchoring: { enabled: false } };
    case 'verify_audit': return { valid: true, eventsVerified: 2045, message: 'ok' };
    case 'alerts_get': return { fleetId: base.fleetId, slack: { ending: 'mnop' }, teams: null };
    case 'performance_index': return { summary: { models: [{ model: 'claude-haiku-4-5', calls: 400 }, { model: 'claude-sonnet-4-5', calls: 60 }] } };
    case 'performance_fleet_hourly': return { hourly: [] };
    default: return {};
  }
}

if (typeof window !== 'undefined' && !(window as { __controlsPreview?: boolean }).__controlsPreview) {
  (window as { __controlsPreview?: boolean }).__controlsPreview = true;
  const real = window.fetch.bind(window);
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/fleet/session')) return json({ fleetId: base.fleetId });
    if (url.includes('/api/fleet/control-actions')) return json({ actions: [{ userId: 'u1', by: 'R Haque', action: 'rule', ruleId: null, agentId: null, at: day(0) }] });
    if (url.includes('/api/fleet/engine')) {
      await new Promise((r) => setTimeout(r, state === 'loading' ? 600_000 : 150));
      try { return json(engine(JSON.parse(String(init?.body ?? '{}')))); } catch { return json({ error: 'down' }, 500); }
    }
    return real(input, init);
  };
}

export function ControlsPreview() {
  return <FleetAuthProvider><AppShell><ControlsPage /></AppShell></FleetAuthProvider>;
}
