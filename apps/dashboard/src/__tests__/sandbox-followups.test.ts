// Sandbox follow-ups: the checks' wording, a past test's details open under its own row, and the
// Run your agent checklist doesn't claim the agent was seen before it called.

import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DataTable } from '@whiteroom/ui';
import type { RunStatusResult } from '@/lib/sandbox/api';

vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null, status: 'unauthenticated' }) }));
vi.mock('@/lib/analytics', () => ({ analytics: { capture: () => {} } }));

const { checkGuidance, callArrived, connectProgress, diagStepState, hasNoCalls, recognizedStep } = await import('@/components/sandbox/TestRunFlow');
const { PastTests } = await import('@/components/sandbox/PastTests');

describe('Check wording', () => {
  it('counts the calls that went through', () => {
    const run = { sandboxId: 'd', mode: 'connected' as const, agents: [{ agentId: 'a', totalTasks: 1 }, { agentId: 'b', totalTasks: 1 }], auditLog: [] } as unknown as RunStatusResult;
    expect(checkGuidance('core.connect', 'observed', run, 'anthropic').detail).toBe('2 calls went through WhiteRoom and got a normal reply.');
  });

  it('leaves the live wording alone', () => {
    const live = { mode: 'connected' as const, auditLog: [{ id: 'h', timestamp: '2026-10-12T10:00:00Z', type: 'self_handover', agentId: 'a' }] };
    expect(checkGuidance('core.handoff', 'observed', live, 'anthropic').detail).toBe('Kept going once as the task ran long.');
    expect(checkGuidance('core.resume', 'observed', live, 'anthropic').detail).toBe('Its next call went through normally.');
  });
});

describe('Past tests open under the clicked row', () => {
  const tests = [
    { sandboxId: 's2', destroyedAt: '2026-10-12T11:00:00Z', overall: 'pass' as const, totalTasks: 4, isTrial: false },
    { sandboxId: 's1', destroyedAt: '2026-10-11T10:00:00Z', overall: 'partial' as const, totalTasks: 2, isTrial: false },
    { sandboxId: 's0', destroyedAt: '2026-10-10T10:00:00Z', overall: 'pass' as const, totalTasks: 6, isTrial: true },
  ];

  it('puts the details directly beneath the open row, linked by aria-controls', () => {
    const html = renderToStaticMarkup(createElement(PastTests, { preview: tests, previewOpen: 's1' }));
    const rows = [...html.matchAll(/<div role="row"[^>]*>/g)].map((m) => m[0]).slice(1);
    expect(rows).toHaveLength(4);
    // Row s2 closed, then s1 open, then its details, then s0.
    expect(rows[0]).toContain('aria-expanded="false"');
    expect(rows[0]).not.toContain('aria-controls');
    expect(rows[1]).toContain('aria-expanded="true"');
    expect(rows[2]).toContain('wr-table__expanded');
    expect(rows[3]).toContain('aria-expanded="false"');
    const controls = rows[1].match(/aria-controls="([^"]+)"/)![1];
    const detail = html.slice(html.indexOf(rows[2]));
    expect(detail.startsWith(`<div role="row" class="wr-table__expanded"><div role="gridcell" aria-colspan="4" id="${controls}">`)).toBe(true);
    // Today's content, and nothing below the table.
    expect(detail).toContain('Test ID');
    const beforeNextRow = detail.slice(0, detail.indexOf(rows[3]));
    expect(beforeNextRow).toContain('Test ID');
    expect(beforeNextRow).toContain('>s1</dd>');
    expect(beforeNextRow).toContain('>2 <span');
    expect(html).toContain('>Close</button>');
  });

  it('shows no details while every row is closed', () => {
    const html = renderToStaticMarkup(createElement(PastTests, { preview: tests }));
    expect(html).not.toContain('wr-table__expanded');
    expect(html).not.toContain('aria-controls');
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(3);
  });

  it('leaves tables without expandable rows unchanged', () => {
    type Row = { id: string };
    const html = renderToStaticMarkup(createElement(DataTable<Row>, {
      caption: 'Runs', rows: [{ id: 'a' }], rowKey: (r) => r.id, onOpen: () => {}, expandedKey: 'a',
      columns: [{ key: 'id', header: 'ID', width: '1fr', render: (r) => r.id }],
    }));
    expect(html).not.toMatch(/aria-expanded|aria-controls|wr-table__expanded|wr-table--expandable/);
  });
});

describe('Run your agent: recognized only once it calls', () => {
  const fresh = {
    sandboxId: 'w', mode: 'connected' as const, expiresInSeconds: 1790, agents: [],
    // A new test logs "Test started" before any call.
    auditLog: [{ id: 'w0', timestamp: '2026-10-12T10:00:00Z', type: 'fleet_created', agentId: 'system' }],
  } as unknown as RunStatusResult;

  it('waits for a fresh test', () => {
    expect(callArrived(fresh)).toBe(false);
    expect(hasNoCalls(fresh)).toBe(true);
    expect(recognizedStep(fresh, 'test-agent')).toEqual({ label: 'Waiting for your agent', sub: 'Run one normal task with the code above' });
  });

  it('names the agent once a call registers it', () => {
    const called = { ...fresh, agents: [{ agentId: 'support-bot', totalTasks: 0 }], auditLog: [...fresh.auditLog!, { id: 'r', timestamp: '2026-10-12T10:01:00Z', type: 'register', agentId: 'support-bot' }] } as unknown as RunStatusResult;
    expect(callArrived(called)).toBe(true);
    expect(hasNoCalls(called)).toBe(false);
    expect(recognizedStep(called, 'support-bot')).toEqual({ label: 'Your agent is recognized', sub: 'Seen as support-bot' });
  });

  it('counts a failed call as arrived', () => {
    const failed = { ...fresh, failedCalls: { count: 1, last: { at: '2026-10-12T10:01:00Z', agentId: 'support-bot', status: 401, reason: 'upstream_error', message: 'bad key' } } } as unknown as RunStatusResult;
    expect(callArrived(failed)).toBe(true);
    expect(hasNoCalls(failed)).toBe(false);
    // Named from the failed call, not the page's placeholder.
    expect(recognizedStep(failed, 'test-agent')).toEqual({ label: 'Your agent is recognized', sub: 'Seen as support-bot' });
  });

  it('shows step 2 in progress only while waiting, and done once a call arrives', () => {
    const shown = connectProgress(fresh, 'anthropic').diagShown;
    expect(diagStepState(shown, { at: 2, done: callArrived(fresh) })).toBe('active');
    const called = { ...fresh, agents: [{ agentId: 'support-bot', role: 'worker', status: 'active', watchMinutes: 2, watchCount: 0, totalTasks: 0, totalTokens: 0, pairedWith: null, currentWatch: null }] } as unknown as RunStatusResult;
    expect(diagStepState(connectProgress(called, 'anthropic').diagShown, { at: 2, done: callArrived(called) })).toBe('done');
    expect(diagStepState(2, { at: 3 })).toBe('pending');
    expect(diagStepState(3, { at: 3, fail: {} })).toBe('fail');
  });

  it('says when the call had no agent name', () => {
    const unnamed = { ...fresh, auditLog: [...fresh.auditLog!, { id: 'u', timestamp: '2026-10-12T10:01:00Z', type: 'unnamed_call_refused', agentId: null }] } as unknown as RunStatusResult;
    expect(hasNoCalls(unnamed)).toBe(false);
    expect(recognizedStep(unnamed, 'test-agent')).toEqual({ label: 'Your agent called without a name', sub: 'Add the x-whiteroom-agent header from the code above' });
  });
});
