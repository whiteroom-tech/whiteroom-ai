import { afterEach, describe, expect, it } from 'vitest';
import {
  buildSnapshot, canonicalJson, entitlementsV2Enabled, outcomeFor, snapshotHash, v2Body,
} from '@/lib/entitlement-snapshot';
import { SANDBOX_LIMITS, trialStatus } from '@/lib/plans';

const base = { principal: 'u1', revision: 7, fleetIds: ['f-b', 'f-a'] as string[], closing: null };

afterEach(() => { delete process.env.ENTITLEMENTS_V2; });

describe('ENTITLEMENTS_V2', () => {
  it.each([undefined, '', 'off', 'ON', 'true', '1', ' on'])('is off for %s', (v) => {
    if (v === undefined) delete process.env.ENTITLEMENTS_V2; else process.env.ENTITLEMENTS_V2 = v;
    expect(entitlementsV2Enabled()).toBe(false);
  });
  it('is on only for exactly "on"', () => {
    process.env.ENTITLEMENTS_V2 = 'on';
    expect(entitlementsV2Enabled()).toBe(true);
  });
});

describe('buildSnapshot', () => {
  it('a trial account: Starter production limits, the trial Sandbox column', () => {
    const s = buildSnapshot({ ...base, plan: 'starter', onTrial: true });
    expect(s).toEqual({
      principal: 'u1', revision: 7, plan: 'trial',
      production: { access: true, maxFleets: 1, maxAgentsPerFleet: 500, includedAgents: 3, retentionDays: 30 },
      sandbox: { enabled: true, sampleRunsPerDay: 3, practiceRunsPerDay: 5, inflight: 4, rpm: 60, retentionDays: 30 },
      fleets: [{ id: 'f-a', role: 'production' }, { id: 'f-b', role: 'production' }],
      transfers: [],
      closing: null,
    });
  });

  it.each([
    ['starter', { access: true, maxFleets: 1, maxAgentsPerFleet: 500, includedAgents: 3, retentionDays: 30 }],
    ['pro', { access: true, maxFleets: 10, maxAgentsPerFleet: 500, includedAgents: 7, retentionDays: 365 }],
    ['enterprise', { access: true, maxFleets: 100, maxAgentsPerFleet: 1000, includedAgents: null, retentionDays: 365 }],
    // An ended free period runs nothing, as the unversioned push's status: inactive.
    ['expired', { access: false, maxFleets: 1, maxAgentsPerFleet: 0, includedAgents: null, retentionDays: 30 }],
  ] as const)('%s: production limits are plans.ts, unchanged', (plan, production) => {
    const s = buildSnapshot({ ...base, plan, onTrial: false });
    expect(s.production).toEqual(production);
    expect(s.sandbox).toEqual(SANDBOX_LIMITS[plan]);
    expect(s.plan).toBe(plan);
  });

  it('a zero-fleet account still gets a complete snapshot', () => {
    const s = buildSnapshot({ ...base, fleetIds: [], plan: 'pro', onTrial: false });
    expect(s.fleets).toEqual([]);
    expect(s.production.access).toBe(true);
  });

  it('carries only a deletion as closing, never a lapse', () => {
    const closesAt = '2026-12-01T00:00:00.000Z';
    expect(buildSnapshot({ ...base, plan: 'pro', onTrial: false, closing: { closesAt, reason: 'deleted' } }).closing).toEqual({ closesAt, reason: 'deleted' });
    expect(buildSnapshot({ ...base, plan: 'pro', onTrial: false, closing: { closesAt, reason: 'lapsed' } }).closing).toBeNull();
  });

  it('keeps transfers only for fleets it grants to this account, once each', () => {
    const s = buildSnapshot({
      ...base, plan: 'pro', onTrial: false,
      transfers: [
        { fleet: 'f-a', from: 'u0', to: 'u1' },
        { fleet: 'f-a', from: 'u0', to: 'u1' },
        { fleet: 'f-gone', from: 'u0', to: 'u1' },
        { fleet: 'f-b', from: 'u1', to: 'u9' },
      ],
    });
    expect(s.transfers).toEqual([{ fleet: 'f-a', from: 'u0', to: 'u1' }]);
  });
});

describe('canonical bytes', () => {
  it('the same snapshot is the same bytes and hash whatever its key order (a jsonb round trip)', () => {
    const s = buildSnapshot({ ...base, plan: 'pro', onTrial: false });
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(s).reverse())));
    reordered.production = Object.fromEntries(Object.entries(reordered.production).reverse());
    expect(canonicalJson(reordered)).toBe(canonicalJson(s));
    expect(snapshotHash(reordered)).toBe(snapshotHash(s));
    expect(v2Body(reordered)).toBe(v2Body(s));
  });

  it('a different snapshot is a different hash', () => {
    const a = buildSnapshot({ ...base, plan: 'pro', onTrial: false });
    const b = buildSnapshot({ ...base, plan: 'starter', onTrial: false });
    expect(snapshotHash(a)).not.toBe(snapshotHash(b));
  });

  it('the body is version 2 with one principal', () => {
    const s = buildSnapshot({ ...base, plan: 'pro', onTrial: false });
    expect(JSON.parse(v2Body(s))).toEqual({ version: 2, principals: [s] });
  });
});

describe('outcomeFor', () => {
  it('finds this account and revision', () => {
    const body = { results: [{ principal: 'u2', revision: 7, outcome: 'applied' }, { principal: 'u1', revision: 7, outcome: 'stale' }] };
    expect(outcomeFor(body, 'u1', 7)).toEqual({ outcome: 'stale' });
  });
  it('keeps a rejection reason', () => {
    expect(outcomeFor({ results: [{ principal: 'u1', revision: 7, outcome: 'rejected', reason: 'bad' }] }, 'u1', 7)).toEqual({ outcome: 'rejected', reason: 'bad' });
  });
  it.each([
    null, {}, { results: 'x' }, { results: [{ principal: 'u1', revision: 8, outcome: 'applied' }] },
    { results: [{ principal: 'u1', revision: 7, outcome: 'maybe' }] }, { fleets: [] },
  ])('is null without a matching, known outcome: %j', (body) => {
    expect(outcomeFor(body, 'u1', 7)).toBeNull();
  });
});

describe('trialStatus', () => {
  const now = new Date('2026-11-08T12:00:00Z');
  const future = '2026-11-20T00:00:00Z';
  const past = '2026-11-01T00:00:00Z';
  // A NULL state is legacy: exactly isTrialActive(trial_ends_at), as today.
  it.each([
    [null, future, 'active'], [null, past, 'ended'], [null, null, 'ended'],
    ['active', future, 'active'], ['active', past, 'ended'],
    // trial_ends_at moved on (an extension, written by any code) wins.
    ['ended', future, 'active'], ['ended', past, 'ended'],
    ['not_started', past, 'not_started'], ['not_started', null, 'not_started'],
    ['not_started', future, 'active'],
  ] as const)('state %s, ends %s → %s', (state, ends, want) => {
    expect(trialStatus(state, ends, now)).toBe(want);
  });
});
