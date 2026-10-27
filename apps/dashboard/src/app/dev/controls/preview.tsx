'use client';

import { AppShell } from '@/components/AppShell';
import { FleetAuthProvider } from '@/hooks/useFleetAuth';
import ControlsPage from '@/app/(citadel)/controls/page';
import type { GovernanceRule } from '@/lib/whiteroom/types';

// The engine and session, stood in for in the browser (installed before the
// page's first request). Shaped like the demo fleet in the mockup: one rule
// blocking, two overlapping spend caps, two identical loop breakers, an
// allowlist missing a model one agent uses, a Keywords rule for one agent,
// and a Tool list with nothing picked. ?state=empty (no rules), ?state=fail
// (the rules can't be read) and ?state=loading show the other states.
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
  { ...base, id: 'r5', version: 1, ruleType: 'keyword', mode: 'watch', response: 'block', appliesTo: ['lead-agent'], params: { keywords: ['password'], where: 'incoming', wholeWord: true } },
  { ...base, id: 'r6', version: 1, ruleType: 'call_rate', mode: 'off', response: 'block', appliesTo: ['lead-agent'], params: { maxCalls: 60 } },
  { ...base, id: 'r7', version: 1, ruleType: 'tool_list', mode: 'off', response: 'block', appliesTo: 'all', params: { blockedTools: [] } },
];
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
const counts = (n: Partial<Record<'blocked' | 'paused' | 'stopped' | 'toldYou' | 'wouldAct', number>>) => ({ blocked: 0, paused: 0, stopped: 0, toldYou: 0, wouldAct: 0, ...n });

function engine(body: Record<string, unknown>): unknown {
  switch (body.action) {
    case 'governance_list': if (state === 'fail') throw new Error('down'); return { fleetId: base.fleetId, rules, history, agents: AGENTS, govV1: true };
    case 'governance_create_rule': {
      const type = body.rule_type as GovernanceRule['ruleType'];
      const defaults: Record<string, GovernanceRule['params']> = {
        spend_cap: { dailyCap: 50, scope: 'day', unit: 'dollars' }, loop_breaker: { threshold: 100, scope: 'run', ignoreTools: [] },
        model_allowlist: { allowedModels: [] }, tool_list: { blockedTools: [] }, call_rate: { maxCalls: 60 }, keyword: { keywords: [], where: 'incoming', wholeWord: true },
      };
      const rule = { ...base, changedAt: new Date().toISOString(), id: `n${++version}`, version: 1, ruleType: type, mode: 'watch', response: 'block', appliesTo: (body.applies_to as GovernanceRule['appliesTo']) ?? 'all', params: defaults[type] } as GovernanceRule;
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
    case 'rule_would_act': return { fleetId: base.fleetId, ruleId: body.rule_id, byAgent: body.rule_id === 'r2' ? { 'code-reviewer': 44 } : {}, unversioned: false, since: day(4) };
    case 'rule_actions': return { fleetId: base.fleetId, totals: counts({ wouldAct: 120 }), byAgent: { 'code-reviewer': counts({ wouldAct: 60 }), 'lead-agent': counts({ wouldAct: 60 }) },
      byRule: { model_allowlist: counts({ wouldAct: 60 }), loop_breaker: counts({ wouldAct: 60 }) }, byRuleId: { r2: counts({ wouldAct: 60 }), r9: counts({ wouldAct: 60 }) } };
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
