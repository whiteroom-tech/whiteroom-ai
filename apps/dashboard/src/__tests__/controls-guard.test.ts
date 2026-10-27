import { describe, expect, it } from 'vitest';
import { canAct, longestWatchHours, stopBlockedReason, stopCheck, stopPhrase } from '@/lib/controls-guard';
import { agentMenu } from '@/components/home/AgentActions';
import type { GovernanceHistoryEntry } from '@/lib/whiteroom/types';

const h = (time: string, description: string, ruleId = 'r1'): GovernanceHistoryEntry => ({ id: time, ruleId, ruleType: 'spend_cap', description, by: 'dashboard', time });
const NOW = Date.parse('2026-10-03T12:00:00Z');

describe('how long a rule has watched', () => {
  it('counts an unbroken stretch in Watch, up to now while still watching', () => {
    const hist = [h('2026-10-01T12:00:00Z', 'Added new Spend cap rule'), h('2026-10-02T00:00:00Z', 'Off → Watch')];
    expect(longestWatchHours('r1', hist, 'watch', NOW)).toBe(36);
  });

  it('keeps the longest finished stretch after it moved to Enforce', () => {
    const hist = [h('2026-10-01T00:00:00Z', 'Off → Watch'), h('2026-10-02T06:00:00Z', 'Watch → Enforce')];
    expect(longestWatchHours('r1', hist, 'enforce', NOW)).toBe(30);
  });

  it('counts from creation for a rule created in Watch, and ignores other rules and non-mode changes', () => {
    const hist = [h('2026-10-03T00:00:00Z', 'Added new Spend cap rule'), h('2026-10-03T01:00:00Z', 'Then → Pause'), h('2026-09-01T00:00:00Z', 'Off → Watch', 'r2')];
    expect(longestWatchHours('r1', hist, 'watch', NOW)).toBe(12);
    expect(longestWatchHours('r1', [], 'watch', NOW)).toBe(0);
  });
});

describe('the Stop guard', () => {
  it('blocks Stop until a day in Watch, and says how long it has run', () => {
    const recent = [h('2026-10-03T07:30:00Z', 'Off → Watch')];
    expect(stopBlockedReason('r1', recent, 'watch', NOW)).toMatch(/24 hours.*4 hours\.$/);
    expect(stopBlockedReason('r1', [h('2026-10-03T11:30:00Z', 'Off → Watch')], 'watch', NOW)).toMatch(/less than an hour/);
    expect(stopBlockedReason('r1', [h('2026-10-01T00:00:00Z', 'Off → Watch')], 'watch', NOW)).toBeNull();
  });

  it('asks for the agent names it covers, or "stop all agents"', () => {
    expect(stopPhrase(['lead-agent', 'scout'])).toBe('lead-agent, scout');
    expect(stopPhrase('all')).toBe('stop all agents');
  });
});

describe('which rule changes need the Stop guard', () => {
  const watched = [h('2026-10-01T00:00:00Z', 'Off → Watch')];
  const fresh = [h('2026-10-03T11:00:00Z', 'Off → Watch')];
  const rule = (mode: string, response: 'block' | 'stop') => ({ id: 'r1', mode, response });

  it('asks to confirm Stop + Enforce whichever is set last, once watched long enough', () => {
    const enforced = [...watched, h('2026-10-02T06:00:00Z', 'Watch → Enforce')];
    expect(stopCheck(rule('enforce', 'block'), { response: 'stop' }, enforced, NOW)).toEqual({ kind: 'confirm' });
    expect(stopCheck(rule('watch', 'stop'), { mode: 'enforce' }, watched, NOW)).toEqual({ kind: 'confirm' });
  });

  it('blocks it before a day in Watch', () => {
    expect(stopCheck(rule('watch', 'stop'), { mode: 'enforce' }, fresh, NOW).kind).toBe('blocked');
  });

  it('lets everything else through: Stop while watching, other responses, leaving Stop + Enforce', () => {
    expect(stopCheck(rule('watch', 'block'), { response: 'stop' }, fresh, NOW)).toEqual({ kind: 'ok' });
    expect(stopCheck(rule('enforce', 'block'), { mode: 'watch' }, fresh, NOW)).toEqual({ kind: 'ok' });
    expect(stopCheck(rule('enforce', 'stop'), { mode: 'watch' }, fresh, NOW)).toEqual({ kind: 'ok' });
  });

  it('reads the engine\'s exact history wording', () => {
    expect(longestWatchHours('r1', [h('2026-10-02T12:00:00Z', 'Off → Watch')], 'watch', NOW)).toBe(24);
    expect(longestWatchHours('r1', [h('2026-10-02T12:00:00Z', 'Off -> Watch')], 'watch', NOW)).toBe(0);
  });
});

describe('Home agent menu', () => {
  it('offers Resume for a held agent, else Pause and Stop', () => {
    expect(agentMenu({ hold: { state: 'paused', by: 'dashboard', reason: null, at: '' } }).map((i) => i.act)).toEqual(['resume']);
    expect(agentMenu({ hold: null }).map((i) => i.act)).toEqual(['pause', 'stop']);
  });
});

describe('which rules turn on refusals for unnamed calls (engine fleetHasEnforcingRule)', () => {
  type R = Parameters<typeof canAct>[0];
  const r = (ruleType: string, mode: string, params: Record<string, unknown> = {}) => ({ ruleType, mode, params }) as unknown as R;

  it('a model allowlist or tool list in Enforce counts only with entries', () => {
    expect(canAct(r('model_allowlist', 'enforce', { allowedModels: ['claude-sonnet-4-20250514'] }))).toBe(true);
    expect(canAct(r('model_allowlist', 'enforce', { allowedModels: [] }))).toBe(false);
    expect(canAct(r('tool_list', 'enforce', { blockedTools: ['send_email'] }))).toBe(true);
    expect(canAct(r('tool_list', 'enforce', { blockedTools: [] }))).toBe(false);
  });

  it('Watch and Off never count', () => {
    for (const mode of ['watch', 'off']) {
      expect(canAct(r('spend_cap', mode, { limit: 1000 }))).toBe(false);
      expect(canAct(r('model_allowlist', mode, { allowedModels: ['m'] }))).toBe(false);
    }
  });

  it('other rule types count whenever they are in Enforce', () => {
    for (const t of ['spend_cap', 'loop_breaker', 'call_rate']) expect(canAct(r(t, 'enforce'))).toBe(true);
  });

  it('Alert me never counts: it lets every call through', () => {
    const withResponse = (response: string) => ({ ...r('spend_cap', 'enforce'), response }) as unknown as R;
    expect(canAct(withResponse('notify'))).toBe(false);
    for (const response of ['block', 'pause', 'stop']) expect(canAct(withResponse(response))).toBe(true);
  });
});

describe('Record only time from history snapshots', async () => {
  const { actionAvailableFrom, keywordBlockCheck } = await import('@/lib/controls-guard');
  const H = 3_600_000;
  const t0 = Date.parse('2026-10-20T00:00:00Z');
  const snap = (mode: 'off' | 'watch' | 'enforce') => ({ mode, response: 'block' as const, alsoNotify: false, appliesTo: 'all' as const, params: { threshold: 5, scope: 'run' as const, ignoreTools: [] } });
  const entry = (id: string, at: number, description: string, before: ReturnType<typeof snap> | null, after: ReturnType<typeof snap> | null) =>
    ({ id, ruleId: 'r', ruleType: 'loop_breaker' as const, description, by: 't', time: new Date(at).toISOString(), before, after });

  it('reads an Undo (its own description) as the mode change it is: Stop opens 24 hours later', () => {
    const history = [
      entry('a', t0, 'Added new Loop breaker rule', null, snap('watch')),
      entry('b', t0 + H, 'Watch → Enforce', snap('watch'), snap('enforce')),
      entry('c', t0 + 2 * H, 'Undid the last change', snap('enforce'), snap('watch')),
    ];
    expect(actionAvailableFrom('r', history, 'watch', t0 + 3 * H)).toBe(t0 + 26 * H);
    expect(actionAvailableFrom('r', history, 'watch', t0 + 27 * H)).toBeNull();
  });

  it('counts a copied Keywords rule from when it was added, so it can block incoming data a day later', () => {
    const kw = { id: 'r', ruleType: 'keyword', mode: 'watch', response: 'block' as const, params: { keywords: ['x'], where: 'incoming' as const, wholeWord: true } };
    const history = [{ id: 'a', ruleId: 'r', ruleType: 'keyword' as const, description: 'Added a copy of the Keywords rule for all agents', by: 't', time: new Date(t0).toISOString(),
      before: null, after: { mode: 'watch' as const, response: 'block' as const, alsoNotify: false, appliesTo: 'all' as const, params: kw.params } }];
    expect(keywordBlockCheck(kw, { mode: 'enforce' }, history, t0 + 2 * H).kind).toBe('blocked');
    expect(keywordBlockCheck(kw, { mode: 'enforce' }, history, t0 + 25 * H).kind).toBe('confirm');
  });
});
