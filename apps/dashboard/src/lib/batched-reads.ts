// Reads that used to take one engine request per item, done in one where the
// engine can (engine PR 345): Home's change types in one audit_log, Controls'
// Watch counts in one rule_would_act per 50 rules. Older engines get the old
// requests, and every caller sees exactly what those returned.

import {
  auditLog, auditLogBatch, ruleWouldAct, ruleWouldActBatch, RULE_WOULD_ACT_BATCH_MAX, WhiteRoomApiError,
} from '@/lib/whiteroom/client';
import type { AuditLogResponse, RuleWouldActResult } from '@/lib/whiteroom/types';

// Whether this engine takes each batch: null until known. Remembered for the
// page session so an older engine isn't asked the batch on every poll; a
// failed fallback forgets it, so an engine upgraded since gets asked again.
let auditBatch: boolean | null = null;
let wouldBatch: boolean | null = null;

/** For tests: forget what the engine was found to support. */
export function resetBatchSupport(): void {
  auditBatch = null;
  wouldBatch = null;
}

/**
 * The newest `limit` audit events of each type, one result per type in the
 * order asked (null where that read failed), as one audit_log call per type
 * would return them.
 */
export async function auditLogByType(
  fleetId: string, types: readonly string[], limit: number, key?: string,
): Promise<Array<AuditLogResponse | null>> {
  if (auditBatch !== false) {
    let res: Awaited<ReturnType<typeof auditLogBatch>>;
    try {
      res = await auditLogBatch({ fleetId, types, limitPerType: limit }, key);
    } catch {
      auditBatch = null;
      return types.map(() => null);
    }
    if (!res || 'error' in res || !Array.isArray(res.entries)) { auditBatch = null; return types.map(() => null); }
    // Only the top-level echo says the batch was read: an older engine ignores
    // `types` and answers with every type, which isn't used.
    if (Array.isArray(res.types)) {
      auditBatch = true;
      const all = res.entries;
      return types.map((type) => ({ ...res, entries: all.filter((e) => e.type === type) }));
    }
    auditBatch = false;
  }
  const reads = await Promise.all(types.map((type) => auditLog({ fleetId, type, limit }, key).catch(() => null)));
  if (reads.some((r) => !r)) auditBatch = null;
  return reads;
}

const wouldKey = (r: { id: string; version: number }) => `${r.id}@${r.version}`;

/** One rule_would_act per rule, as before engine PR 345; a failed read leaves that rule out. */
async function wouldActsOneByOne(fleetId: string, rules: ReadonlyArray<{ id: string; version: number }>, key?: string) {
  const pairs = await Promise.all(rules.map((r) => ruleWouldAct(fleetId, r.id, r.version, key).then((c) => [wouldKey(r), c] as const, () => null)));
  if (pairs.some((p) => p === null)) wouldBatch = null;
  return pairs.filter((p) => p !== null);
}

/**
 * rule_would_act for each rule version, keyed `${id}@${version}`, read 50 at
 * a time. A failed read leaves its rules out, as a failed single read did.
 */
export async function wouldActsFor(
  fleetId: string, rules: ReadonlyArray<{ id: string; version: number }>, key?: string,
): Promise<Record<string, RuleWouldActResult>> {
  if (!rules.length) return {};
  if (wouldBatch === false) return Object.fromEntries(await wouldActsOneByOne(fleetId, rules, key));
  const chunks: Array<ReadonlyArray<{ id: string; version: number }>> = [];
  for (let i = 0; i < rules.length; i += RULE_WOULD_ACT_BATCH_MAX) chunks.push(rules.slice(i, i + RULE_WOULD_ACT_BATCH_MAX));
  const read = async (chunk: ReadonlyArray<{ id: string; version: number }>) => {
    let res: Awaited<ReturnType<typeof ruleWouldActBatch>>;
    try {
      res = await ruleWouldActBatch(fleetId, chunk.map((r) => ({ ruleId: r.id, ruleVersion: r.version })), key);
    } catch (e) {
      // An older engine refuses a body without rule_id; anything else is a failed read.
      if (e instanceof WhiteRoomApiError && e.status === 400) { wouldBatch = false; return wouldActsOneByOne(fleetId, chunk, key); }
      wouldBatch = null;
      return [];
    }
    const results = Array.isArray(res?.results) ? res.results : null;
    if (!results || results.length !== chunk.length || results.some((r, i) => r?.ruleId !== chunk[i].id)) {
      // Not a batch answer: read them one by one.
      wouldBatch = false;
      return wouldActsOneByOne(fleetId, chunk, key);
    }
    wouldBatch = true;
    return chunk.map((r, i) => {
      // The single read's answer: the batch adds ruleVersion and drops fleetId.
      const { ruleVersion: _version, ...one } = results[i];
      return [wouldKey(r), { fleetId: res.fleetId, ...one } as RuleWouldActResult] as const;
    });
  };
  return Object.fromEntries((await Promise.all(chunks.map(read))).flat());
}
