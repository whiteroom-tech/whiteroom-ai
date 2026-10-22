// Performance › Agent health and Recommendations, rendered to HTML (react-dom/server):
// what's on screen, not just the helpers behind it.
import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentHealth, Row } from '@/components/performance/AgentHealth';
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
  it('a quiet week: fine, Unusual behaviour is a plain line, Health check folds out closed', () => {
    const html = renderToStaticMarkup(h(AgentHealth, { flagged: flags([]), diagnosis: diag([]), line, onCheck: noop, onReview: noop }));
    expect(html).toContain('Your agents look fine');
    expect(html).toContain('Nothing unusual this week');
    expect(html).not.toMatch(/<details[^>]*>\s*<summary>[\s\S]*?Unusual behaviour/);
    expect(html).toMatch(/<details class="wr-health__row">/);
    expect(html).not.toContain('<details open');
    expect(html).toContain('Check now');
  });

  it('a problem week: both rows start open, the problem has See the fix', () => {
    const runs = [{ agentId: 'lead-agent', startedAt: '2026-10-21T12:00:00', flags: [{ signal: 'repeating_call', tool: 't', calls: 5 }] }] as FlaggedRuns['runs'];
    const html = renderToStaticMarkup(h(AgentHealth, { flagged: flags(runs), diagnosis: diag([finding]), line, onCheck: noop, onReview: noop }));
    expect(html).toContain('lead-agent needs a look');
    expect(html.match(/<details open=""/g)).toHaveLength(2);
    expect(html).toContain('Handing over too often');
    expect(html).toContain('See the fix');
    expect(html).toContain('1 problem · 1 passed');
  });

  it('hidden with no run flags and no health check', () => {
    expect(renderToStaticMarkup(h(AgentHealth, { flagged: flags(null), diagnosis: null, line: null, onCheck: noop, onReview: noop }))).toBe('');
  });
});

describe('fold-out row, rendered', () => {
  const row = { tone: 'ok' as const, text: 'All good' };
  it('with no detail it is a plain line, not a disclosure', () => {
    const html = renderToStaticMarkup(h(Row, { label: 'Health check', row, open: true }));
    expect(html).toContain('wr-health__row--plain');
    expect(html).not.toContain('<details');
  });
  it('with detail it follows its default', () => {
    expect(renderToStaticMarkup(h(Row, { label: 'L', row, open: true }, h('p', null, 'detail')))).toContain('<details open=""');
    expect(renderToStaticMarkup(h(Row, { label: 'L', row, open: false }, h('p', null, 'detail')))).not.toContain('<details open');
  });
});

describe('Recommendations, rendered', () => {
  const rec = { id: 'pr_cache', detector: 'review_cache_behavior', agentId: 'lead-agent', source: 'engine', cohort: '', action: '', status: 'open', verificationStatus: 'none', currentFindingId: 'pf', feedbackCount: 0, createdAt: '2026-10-01T12:00:00Z', updatedAt: '2026-10-01T12:00:00Z', summary: 'Cache read rate is high.' } as RecommendationDetail;
  const props = {
    recs: [rec], total: 1, status: 'open', onStatus: noop, showStatuses: false, onShowStatuses: noop, agentFilter: '', onAgentFilter: noop, showAgentFilter: false,
    filtered: false, hasCalls: true, loading: false, error: null, notice: null, hasMore: false, onMore: noop, onSelectAgent: noop, onSelectEvidence: noop,
    onFeedback: noop, onDiagnosisFeedback: async () => true, feedbackLoading: null, feedbackError: null,
  };
  it('opens on Open: count says "open", status filters hidden behind a link, no agent filter for one agent', () => {
    const html = renderToStaticMarkup(h(RecommendationsCard, props));
    expect(html).toContain('1</span> open');
    expect(html).toContain('Show closed and other statuses');
    expect(html).not.toContain('Show recommendations by status');
    expect(html).not.toContain('Filter by agent');
  });
  it('older rows: a title from the detector, View evidence and More, no "none" badge', () => {
    const html = renderToStaticMarkup(h(RecommendationsCard, props));
    expect(html).toContain('Cache behavior');
    expect(html).toContain('View evidence');
    expect(html).toContain('>More<');
    expect(html).not.toContain('Mark as fixed');
    expect(html).not.toMatch(/>none</);
  });
  it('after "Show closed…": the status filters show and the link goes', () => {
    const html = renderToStaticMarkup(h(RecommendationsCard, { ...props, status: 'all', showStatuses: true }));
    expect(html).toContain('Show recommendations by status');
    expect(html).not.toContain('Show closed and other statuses');
  });
  it('an empty filtered list says so, not "nothing to review"', () => {
    const html = renderToStaticMarkup(h(RecommendationsCard, { ...props, recs: [], total: 0, filtered: true, showAgentFilter: true, agentFilter: 'x' }));
    expect(html).toContain('No open recommendations for this agent.');
  });
});
