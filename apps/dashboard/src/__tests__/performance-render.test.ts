// Performance › Agent health and Recommendations, rendered to HTML (react-dom/server):
// what's on screen, not just the helpers behind it.
import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentHealthHeader, HealthByAgent, HealthChecks } from '@/components/performance/AgentHealth';
import { RecommendationsCard } from '@/app/(citadel)/performance/_components/Recommendations';
import type { FlaggedRuns } from '@/components/performance/UnusualBehaviour';
import type { DiagnosisFinding, FleetDiagnosis, RecommendationDetail } from '@/lib/whiteroom/types';

const days = ['2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22'];
const flags = (runs: FlaggedRuns['runs']): FlaggedRuns => ({ runs, truncated: false, failed: false, loading: false, days });
const finding = { recommendationId: 'pr_1', findingId: 'pf_1', findingVersion: 1, detector: 'review_handover_churn', detectorVersion: 1, status: 'open', measures: {}, estWastedTokens: null, estWastedCostMicros: null, evidenceCallIds: [], coverage: 'complete', limitations: null, suggestedAction: null } as unknown as DiagnosisFinding;
const diag = (findings: DiagnosisFinding[]): FleetDiagnosis => ({
  checkedAt: '2026-10-22T10:00:00Z', source: 'background', truncated: false, readyAgents: 1, busiest: null, minCalls: 50, waiting: [], skipped: [],
  reports: [{ schema: 'diagnosis.v1', agentId: 'lead-agent', window: { from: '', to: '', days: 7, calls: 80, watches: 12 }, findings, clear: [{ detector: 'review_tool_loops', note: null }], notMeasured: [] }],
});
const line = { text: 'Checked 2 hours ago · 1 agent', action: { label: 'Check now' }, busy: false, error: false };
const noop = () => {};

describe('Agent health, rendered', () => {
  const card = (p: Partial<Parameters<typeof HealthByAgent>[0]>) => renderToStaticMarkup(h(HealthByAgent, { flagged: flags([]), diagnosis: diag([]), state: 'ready', line, onOpenRec: noop, onSelectAgent: noop, ...p }));

  it('a quiet week: no issues in N checks and nothing unusual, no table, Health checks folded closed', () => {
    const html = card({});
    expect(html).toContain('No issues in 1 check');
    expect(html).toContain('Nothing unusual in the last 7 days');
    expect(html).not.toContain('wr-hba__row');
    expect(html).not.toContain('wr-hba__top--warn');
    const checks = renderToStaticMarkup(h(HealthChecks, { diagnosis: diag([]) }));
    expect(checks).toMatch(/aria-expanded="false"[^>]*>[\s\S]*?Health checks/);
    expect(checks).toContain('1 passed');
  });

  it('a problem week: the headline counts the problem, the agent has a row with its problem and its flagged runs, checks stay folded', () => {
    const runs = [{ agentId: 'lead-agent', startedAt: '2026-10-21T12:00:00', flags: [{ signal: 'repeating_call', tool: 't', calls: 5 }] }] as FlaggedRuns['runs'];
    const html = card({ flagged: flags(runs), diagnosis: diag([finding]) });
    expect(html).toContain('1 problem in 2 checks');
    expect(html).toContain('wr-hba__top--warn');
    expect(html).toContain('1 run flagged in the last 7 days');
    // The problem is a button to its own fix, named for what it does.
    expect(html).toMatch(/<button[^>]*class="wr-hba__tag"[^>]*aria-label="Starting over too often: see the fix"/);
    expect(html).toContain('Flagged for: repeating the same call');
    // The count links to that agent's flagged runs, and says so to a screen reader.
    expect(html).toContain('href="/runs?agent=lead-agent&amp;show=flagged"');
    expect(html).toContain('aria-label="1 flagged run for lead-agent"');
    expect(html).toContain('>1 run →<');
    // Problems are in the table: the checks start closed even with one open.
    const checks = renderToStaticMarkup(h(HealthChecks, { diagnosis: diag([finding]) }));
    expect(checks).toMatch(/aria-expanded="false"[^>]*>[\s\S]*?Health checks/);
    expect(checks).toContain('1 problem · 1 passed');
  });

  it('a failed health read says so and keeps the flagged runs; it never reads as nothing found', () => {
    const runs = [{ agentId: 'lead-agent', startedAt: '2026-10-21T12:00:00', flags: [{ signal: 'error_streak', calls: 3 }] }] as FlaggedRuns['runs'];
    const html = card({ flagged: flags(runs), diagnosis: null, state: 'failed', line: null });
    expect(html).toContain('Couldn’t load health checks. Reload to try again.');
    expect(html).not.toContain('No issues');
    expect(html).not.toContain('Open problems');
    expect(html).toContain('1 run flagged in the last 7 days');
    expect(html).toContain('lead-agent');
  });

  it('the check off: flagged runs alone, no problems column; with nothing flagged either, one plain line', () => {
    const runs = [{ agentId: 'lead-agent', startedAt: '2026-10-21T12:00:00', flags: [{ signal: 'error_streak', calls: 3 }] }] as FlaggedRuns['runs'];
    const html = card({ flagged: flags(runs), diagnosis: null, state: 'unavailable', line: null });
    expect(html).not.toContain('Open problems');
    expect(html).toContain('Flagged for');
    expect(card({ diagnosis: null, state: 'unavailable', line: null })).toContain('Nothing unusual in the last 7 days');
  });

  it('only the newest flagged runs read: every count is a lower bound, on screen and read out', () => {
    const runs = [{ agentId: 'lead-agent', startedAt: '2026-10-21T12:00:00', flags: [{ signal: 'error_streak', calls: 3 }] }] as FlaggedRuns['runs'];
    const html = card({ flagged: { ...flags(runs), truncated: true } });
    expect(html).toContain('1+ runs flagged in the last 7 days');
    expect(html).toContain('>1+ runs →<');
    expect(html).toContain('aria-label="1+ flagged runs for lead-agent"');
    expect(html).toContain('Showing the newest 1 flagged runs.');
  });

  it('hidden with no run flags and no health check', () => {
    expect(card({ flagged: flags(null), diagnosis: null, state: 'unavailable', line: null })).toBe('');
  });


  it('the heading is always there with its anchor; the check button and report link only when given', () => {
    const on = renderToStaticMarkup(h(AgentHealthHeader, { line, onCheck: noop, onReport: async () => null }));
    expect(on).toContain('id="agent-health-heading"');
    expect(on).toContain('Check now');
    expect(on).toContain('Download report');
    const off = renderToStaticMarkup(h(AgentHealthHeader, { line: null, onCheck: noop }));
    expect(off).toContain('id="agent-health-heading"');
    expect(off).not.toContain('Check now');
    expect(off).not.toContain('Download report');
  });
});

describe('Recommendations, rendered', () => {
  const rec = { id: 'pr_cache', detector: 'review_cache_behavior', agentId: 'lead-agent', source: 'engine', cohort: '', action: '', status: 'open', verificationStatus: 'none', currentFindingId: 'pf', feedbackCount: 0, createdAt: '2026-10-01T12:00:00Z', updatedAt: '2026-10-01T12:00:00Z', summary: 'Cache read rate is high.' } as RecommendationDetail;
  const props = {
    recs: [rec], total: 1, status: 'open', onStatus: noop, showStatuses: false, onShowStatuses: noop, agentFilter: '', onAgentFilter: noop, showAgentFilter: false,
    filtered: false, hasCalls: true, loading: false, error: null, notice: null, hasMore: false, onMore: noop, expanded: false, onExpand: noop, onSelectAgent: noop, onSelectEvidence: noop,
    onFeedback: noop, onDiagnosisFeedback: async () => true, feedbackLoading: null, feedbackError: null,
  };
  it('opens on Open: count says "open", status filters hidden behind a link, no agent filter for one agent', () => {
    const html = renderToStaticMarkup(h(RecommendationsCard, props));
    expect(html).toContain('>1 open<');
    expect(html).toContain('Show past recommendations');
    expect(html).not.toContain('Show recommendations by status');
    expect(html).not.toContain('Filter by agent');
  });
  it('older rows: a title from the detector, See why and Options, no "none" badge', () => {
    const html = renderToStaticMarkup(h(RecommendationsCard, props));
    expect(html).toContain('Cache behavior');
    expect(html).toContain('See why');
    expect(html).toContain('>Options<');
    expect(html).not.toContain('Mark as fixed');
    expect(html).not.toMatch(/>none</);
  });
  it('a row with no current finding offers no feedback, and says why, so nothing doomed is sent', () => {
    const html = renderToStaticMarkup(h(RecommendationsCard, { ...props, recs: [{ ...rec, currentFindingId: null }] }));
    expect(html).toContain('See why');
    expect(html).not.toContain('>Options<');
    expect(html).toContain('Can’t be marked yet: there’s no current evidence for it.');
    // A closed row has nothing to mark anyway: no note.
    expect(renderToStaticMarkup(h(RecommendationsCard, { ...props, status: 'all', recs: [{ ...rec, status: 'dismissed', currentFindingId: null }] }))).not.toContain('Can’t be marked yet');
  });
  it('after "Show closed…": the status filters show and the link goes', () => {
    const html = renderToStaticMarkup(h(RecommendationsCard, { ...props, status: 'all', showStatuses: true }));
    expect(html).toContain('Show recommendations by status');
    expect(html).not.toContain('Show past recommendations');
  });
  it('an empty filtered list says so, not "nothing to review"', () => {
    const html = renderToStaticMarkup(h(RecommendationsCard, { ...props, recs: [], total: 0, filtered: true, showAgentFilter: true, agentFilter: 'x' }));
    expect(html).toContain('No open recommendations for this agent.');
  });
  it('shows the first three with Show more; opened, all of them and Load more', () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ ...rec, id: `pr_${id}`, summary: `Row ${id}.` }));
    const closed = renderToStaticMarkup(h(RecommendationsCard, { ...props, recs: many, total: 5, hasMore: true }));
    expect(closed.match(/<article/g)).toHaveLength(3);
    expect(closed).toContain('>Show more<');
    // Load more belongs to the opened list.
    expect(closed).not.toContain('Load more');
    const open = renderToStaticMarkup(h(RecommendationsCard, { ...props, recs: many, total: 5, hasMore: true, expanded: true }));
    expect(open.match(/<article/g)).toHaveLength(5);
    expect(open).not.toContain('>Show more<');
    expect(open).toContain('Load more');
    // Three or fewer: nothing to open.
    expect(renderToStaticMarkup(h(RecommendationsCard, { ...props, recs: many.slice(0, 3), total: 3 }))).not.toContain('>Show more<');
  });
  it('a pinned recommendation is first and marked, once, whether or not the list holds it', () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ ...rec, id: `pr_${id}`, summary: `Row ${id}.` }));
    const inList = renderToStaticMarkup(h(RecommendationsCard, { ...props, recs: many, total: 5, pinned: many[4] }));
    expect(inList.match(/<article/g)).toHaveLength(4);
    expect(inList.indexOf('id="rec-pr_e"')).toBeLessThan(inList.indexOf('id="rec-pr_a"'));
    expect(inList.match(/Opened from the health table/g)).toHaveLength(1);
    expect(inList.match(/id="rec-pr_e"/g)).toHaveLength(1);
    // Read by id: not in the loaded list, and no longer open, so it carries its status.
    const outside = renderToStaticMarkup(h(RecommendationsCard, { ...props, recs: many.slice(0, 2), total: 2, pinned: { ...rec, id: 'pr_z', status: 'snoozed' } }));
    expect(outside.indexOf('id="rec-pr_z"')).toBeLessThan(outside.indexOf('id="rec-pr_a"'));
    expect(outside).toContain('>snoozed<');
  });
  it('keeps the way in to past recommendations when none are open', () => {
    const html = renderToStaticMarkup(h(RecommendationsCard, { ...props, recs: [], total: 0 }));
    expect(html).toContain('Nothing to review right now.');
    expect(html).toContain('Show past recommendations');
    expect(html).not.toContain('>Show more<');
  });
});
