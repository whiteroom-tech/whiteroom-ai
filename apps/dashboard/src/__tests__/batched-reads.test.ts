// Home's change types and Controls' Watch counts in one engine read each
// (engine PR 345), with the old one-per-item reads on older engines.
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ log: vi.fn(), batch: vi.fn(), would: vi.fn(), wouldBatch: vi.fn() }));
vi.mock('@/lib/whiteroom/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/whiteroom/client')>()),
  auditLog: api.log,
  auditLogBatch: api.batch,
  ruleWouldAct: api.would,
  ruleWouldActBatch: api.wouldBatch,
}));
const { auditLogByType, resetBatchSupport, wouldActsFor } = await import('@/lib/batched-reads');
const { WhiteRoomApiError } = await import('@/lib/whiteroom/client');

afterEach(() => { for (const f of Object.values(api)) f.mockReset(); resetBatchSupport(); });

const TYPES = ['register', 'agent_paused', 'deregister'];
const at = (m: number) => new Date(Date.UTC(2026, 10, 8, 10, m)).toISOString();
const entry = (id: string, type: string, m: number) => ({ id, type, timestamp: at(m), agentId: 'a' });
const ENTRIES = [entry('p2', 'agent_paused', 9), entry('r2', 'register', 8), entry('p1', 'agent_paused', 7), entry('r1', 'register', 6)];
const head = { fleetId: 'f1', total: 4, limit: 5, filters: { agentIds: ['a'], types: [...TYPES, 'llm_call'] } };
/** The single per-type read an older engine answers. */
const single = async ({ type }: { type: string }) => ({ ...head, entries: ENTRIES.filter((e) => e.type === type) });

describe('auditLogByType', () => {
  it('reads every type in one request and gives each type its own result, as single reads did', async () => {
    api.batch.mockResolvedValue({ ...head, types: TYPES, limitPerType: 5, entries: ENTRIES });
    const reads = await auditLogByType('f1', TYPES, 5, 'k');
    expect(api.batch).toHaveBeenCalledWith({ fleetId: 'f1', types: TYPES, limitPerType: 5 }, 'k');
    expect(api.log).not.toHaveBeenCalled();
    expect(reads.map((r) => r!.entries.map((e) => e.id))).toEqual([['r2', 'r1'], ['p2', 'p1'], []]);
    api.log.mockImplementation(single);
    const singles = await Promise.all(TYPES.map((type) => single({ type })));
    expect(reads.map((r) => r!.entries)).toEqual(singles.map((r) => r.entries));
    // Each type's count and limit are its own, not the batch's across all types.
    expect(reads.map((r) => [r!.total, r!.limit])).toEqual([[2, 5], [2, 5], [0, 5]]);
  });

  it('falls back on an engine with no top-level types (filters.types doesn’t count), and remembers', async () => {
    // An older engine ignores `types`: every type, filters.types listing them all.
    api.batch.mockResolvedValue({ ...head, entries: [entry('c1', 'llm_call', 10), ...ENTRIES] });
    api.log.mockImplementation(single);
    const reads = await auditLogByType('f1', TYPES, 5, 'k');
    expect(api.log.mock.calls.map(([q]) => q)).toEqual(TYPES.map((type) => ({ fleetId: 'f1', type, limit: 5 })));
    expect(reads.map((r) => r!.entries.map((e) => e.id))).toEqual([['r2', 'r1'], ['p2', 'p1'], []]);
    await auditLogByType('f1', TYPES, 5, 'k');
    expect(api.batch).toHaveBeenCalledTimes(1);
    expect(api.log).toHaveBeenCalledTimes(6);
  });

  it('a failed single read is null and asks the batch again next time', async () => {
    api.batch.mockResolvedValue({ ...head, entries: ENTRIES });
    api.log.mockImplementation(async (q: { type: string }) => { if (q.type === 'deregister') throw new Error('down'); return single(q); });
    expect((await auditLogByType('f1', TYPES, 5)).map((r) => r === null)).toEqual([false, false, true]);
    await auditLogByType('f1', TYPES, 5);
    expect(api.batch).toHaveBeenCalledTimes(2);
  });

  it('a failed batch read fails every type, with no fallback', async () => {
    api.batch.mockRejectedValue(new WhiteRoomApiError('HTTP 502', 502));
    expect(await auditLogByType('f1', TYPES, 5)).toEqual([null, null, null]);
    api.batch.mockResolvedValue({ error: 'nope' });
    expect(await auditLogByType('f1', TYPES, 5)).toEqual([null, null, null]);
    expect(api.log).not.toHaveBeenCalled();
  });
});

const rules = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, version: i + 1 }));
const one = (ruleId: string) => ({ ruleId, byAgent: { a: Number(ruleId.slice(1)) }, unversioned: false, since: at(0) });
const batchOk = async (_f: string, list: Array<{ ruleId: string; ruleVersion: number }>) => ({ fleetId: 'f1', results: list.map((r) => ({ ...one(r.ruleId), ruleVersion: r.ruleVersion })) });
const singleOk = async (fleetId: string, ruleId: string) => ({ fleetId, ...one(ruleId) });

describe('wouldActsFor', () => {
  it('reads the rules 50 at a time and answers as single reads did', async () => {
    api.wouldBatch.mockImplementation(batchOk);
    const got = await wouldActsFor('f1', rules(120), 'k');
    expect(api.wouldBatch.mock.calls.map(([, list]) => list.length)).toEqual([50, 50, 20]);
    expect(api.wouldBatch.mock.calls[1][1][0]).toEqual({ ruleId: 'r50', ruleVersion: 51 });
    expect(api.would).not.toHaveBeenCalled();
    expect(Object.keys(got)).toHaveLength(120);
    expect(got['r7@8']).toEqual(await singleOk('f1', 'r7'));
  });

  it('makes no request without Watch rules', async () => {
    expect(await wouldActsFor('f1', [])).toEqual({});
    expect(api.wouldBatch).not.toHaveBeenCalled();
  });

  it('falls back to one read per rule when an older engine answers 400, and remembers', async () => {
    api.wouldBatch.mockRejectedValue(new WhiteRoomApiError('HTTP 400', 400, 'rule_id is required.'));
    api.would.mockImplementation(singleOk);
    api.wouldBatch.mockImplementationOnce(batchOk);
    const fresh = await wouldActsFor('f1', rules(3));
    resetBatchSupport();
    const old = await wouldActsFor('f1', rules(3), 'k');
    expect(old).toEqual(fresh);
    expect(api.would.mock.calls).toEqual([['f1', 'r0', 1, 'k'], ['f1', 'r1', 2, 'k'], ['f1', 'r2', 3, 'k']]);
    await wouldActsFor('f1', rules(3), 'k');
    expect(api.wouldBatch).toHaveBeenCalledTimes(2);
    expect(api.would).toHaveBeenCalledTimes(6);
  });

  it('a new engine refusing one chunk reads it one by one but keeps batching next time', async () => {
    api.wouldBatch.mockRejectedValueOnce(new WhiteRoomApiError('HTTP 400', 400, 'rules must be a list of 1-50 { rule_id, rule_version } (an integer).'));
    api.wouldBatch.mockImplementation(batchOk);
    api.would.mockImplementation(singleOk);
    expect(Object.keys(await wouldActsFor('f1', rules(2)))).toEqual(['r0@1', 'r1@2']);
    expect(api.would).toHaveBeenCalledTimes(2);
    await wouldActsFor('f1', rules(2));
    expect(api.wouldBatch).toHaveBeenCalledTimes(2);
    expect(api.would).toHaveBeenCalledTimes(2);
  });

  it('falls back when the answer isn’t a batch answer', async () => {
    api.wouldBatch.mockResolvedValue({ fleetId: 'f1', byAgent: {}, unversioned: false });
    api.would.mockImplementation(singleOk);
    expect(Object.keys(await wouldActsFor('f1', rules(2)))).toEqual(['r0@1', 'r1@2']);
    expect(api.would).toHaveBeenCalledTimes(2);
  });

  it('a failed read leaves its rules out, as failed single reads did', async () => {
    api.wouldBatch.mockImplementation(async (f: string, list: Array<{ ruleId: string; ruleVersion: number }>) => {
      if (list[0].ruleId === 'r50') throw new WhiteRoomApiError('HTTP 502', 502);
      return batchOk(f, list);
    });
    const got = await wouldActsFor('f1', rules(60));
    expect(Object.keys(got)).toHaveLength(50);
    expect(got['r55@56']).toBeUndefined();
    expect(api.would).not.toHaveBeenCalled();
    // On the fallback, a failed single read leaves just that rule out.
    resetBatchSupport();
    api.wouldBatch.mockReset();
    api.wouldBatch.mockRejectedValue(new WhiteRoomApiError('HTTP 400', 400));
    api.would.mockImplementation(async (f: string, id: string) => { if (id === 'r1') throw new Error('down'); return singleOk(f, id); });
    expect(Object.keys(await wouldActsFor('f1', rules(3)))).toEqual(['r0@1', 'r2@3']);
  });
});
