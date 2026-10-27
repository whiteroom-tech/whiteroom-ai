'use client';

import { AppShell } from '@/components/AppShell';
import { FleetAuthProvider } from '@/hooks/useFleetAuth';
import ControlsPage from '@/app/(citadel)/controls/page';
import type { GovernanceRule } from '@/lib/whiteroom/types';

// The engine and session, stood in for in the browser (installed before the
// page's first request). Shaped like a real fleet: one rule enforcing, three
// watching (two overlapping spend caps), two off, and a Keywords rule.
const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const base = { fleetId: 'acme-claims-prod', changedBy: 'preview', changedAt: day(2) };
let version = 1;
let rules: GovernanceRule[] = [
  { ...base, id: 'r1', version: 1, ruleType: 'loop_breaker', mode: 'enforce', response: 'block', appliesTo: 'all', params: { threshold: 100, scope: 'run', ignoreTools: [] } },
  { ...base, id: 'r2', version: 1, ruleType: 'model_allowlist', mode: 'watch', response: 'block', appliesTo: 'all', params: { allowedModels: ['claude-haiku-4-5-20251001'] } },
  { ...base, id: 'r3', version: 1, ruleType: 'spend_cap', mode: 'watch', response: 'block', appliesTo: 'all', params: { dailyCap: 200, scope: 'day', unit: 'dollars' } },
  { ...base, id: 'r4', version: 1, ruleType: 'spend_cap', mode: 'watch', response: 'block', appliesTo: 'all', params: { dailyCap: 190, scope: 'day', unit: 'dollars' } },
  { ...base, id: 'r5', version: 1, ruleType: 'keyword', mode: 'watch', response: 'notify', appliesTo: ['support-triage', 'invoice-reconciler'], params: { keywords: ['Project Falcon', 'SSN', 'wire transfer'], where: 'both', wholeWord: true } },
  { ...base, id: 'r6', version: 1, ruleType: 'call_rate', mode: 'off', response: 'block', appliesTo: ['lead-agent'], params: { maxCalls: 60 } },
  { ...base, id: 'r7', version: 1, ruleType: 'tool_list', mode: 'off', response: 'block', appliesTo: 'all', params: { blockedTools: [] } },
];
const AGENTS = ['lead-agent', 'support-triage', 'invoice-reconciler', 'code-reviewer', 'market-researcher-with-a-long-name'];
const history = [
  { id: 'h1', ruleId: 'r1', ruleType: 'loop_breaker', description: 'Off → Enforce', by: 'R. Haque', time: day(1),
    before: { mode: 'off', response: 'block', alsoNotify: false, appliesTo: 'all', params: { threshold: 100, scope: 'run', ignoreTools: [] } },
    after: { mode: 'enforce', response: 'block', alsoNotify: false, appliesTo: 'all', params: { threshold: 100, scope: 'run', ignoreTools: [] } } },
  { id: 'h2', ruleId: 'r3', ruleType: 'spend_cap', description: 'Settings updated', by: 'R. Haque', time: day(1),
    before: { mode: 'watch', response: 'block', alsoNotify: false, appliesTo: 'all', params: { dailyCap: 250, scope: 'day', unit: 'dollars' } },
    after: { mode: 'watch', response: 'block', alsoNotify: false, appliesTo: 'all', params: { dailyCap: 200, scope: 'day', unit: 'dollars' } } },
  { id: 'h4', ruleId: 'r8', ruleType: 'spend_cap', description: 'Removed Spend cap rule', by: 'R. Haque', time: day(1),
    before: { mode: 'enforce', response: 'block', alsoNotify: false, appliesTo: ['code-reviewer'], params: { dailyCap: 20, scope: 'day', unit: 'dollars' } }, after: null },
  { id: 'h3', ruleId: 'r5', ruleType: 'keyword', description: 'Added new Keywords rule', by: 'R. Haque', time: day(2) },
];
const counts = (n: Partial<Record<'blocked' | 'paused' | 'stopped' | 'toldYou' | 'wouldAct', number>>) => ({ blocked: 0, paused: 0, stopped: 0, toldYou: 0, wouldAct: 0, ...n });

function engine(body: Record<string, unknown>): unknown {
  switch (body.action) {
    case 'governance_list': return { fleetId: base.fleetId, rules, history, agents: AGENTS, govV1: true };
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
    case 'rule_would_act': return { fleetId: base.fleetId, ruleId: body.rule_id, byAgent: body.rule_id === 'r2' ? { 'lead-agent': 30, 'code-reviewer': 14 } : body.rule_id === 'r5' ? { 'support-triage': 3 } : {}, unversioned: false, since: day(2) };
    case 'rule_actions': return { fleetId: base.fleetId, totals: counts({ blocked: 2, wouldAct: 47 }), byAgent: { 'lead-agent': counts({ blocked: 2, wouldAct: 30 }) }, byRule: { loop_breaker: counts({ blocked: 2 }) } };
    case 'alerts_get': return { fleetId: base.fleetId, slack: { ending: 'mnop' }, teams: null };
    case 'performance_index': return { summary: { models: [{ model: 'claude-haiku-4-5-20251001', calls: 40 }, { model: 'claude-sonnet-4-5-20250929', calls: 9 }] } };
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
    if (url.includes('/api/fleet/control-actions')) return json({ actors: [] });
    if (url.includes('/api/fleet/engine')) {
      await new Promise((r) => setTimeout(r, 150));
      return json(engine(JSON.parse(String(init?.body ?? '{}'))));
    }
    return real(input, init);
  };
}

export function ControlsPreview() {
  return <FleetAuthProvider><AppShell><ControlsPage /></AppShell></FleetAuthProvider>;
}
