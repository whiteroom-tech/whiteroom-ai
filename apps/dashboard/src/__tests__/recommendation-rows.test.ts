// @vitest-environment happy-dom
// Recommendation rows after someone has acted: a rule made from the
// suggestion replaces "Add … in Watch" with its count and a link to it, and a
// fix check shows as a line. The suggestion draft: retry and cancel.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DiagnosisSuggestedAction, RecommendationDetail } from '@/lib/whiteroom/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('next/link', async () => {
  const { createElement } = await import('react');
  return { default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement('a', { href, ...rest }, children as never) };
});
const api = vi.hoisted(() => ({ governanceCreateRule: vi.fn(), performanceRecommendationGet: vi.fn() }));
vi.mock('@/lib/whiteroom/client', async (orig) => ({ ...(await orig<typeof import('@/lib/whiteroom/client')>()), ...api }));

import { RecommendationsCard } from '@/app/(citadel)/performance/_components/Recommendations';
import { SuggestionDraft } from '@/app/(citadel)/controls/_components/SuggestionDraft';

const LOOPS = { toolName: 'search_places', maxRepeats: 9, worstWatch: 14, watchesAffected: 3 };
const loopRule: DiagnosisSuggestedAction = { kind: 'rule', rule: 'loop_breaker', mode: 'watch', appliesTo: ['lead-agent'], params: { threshold: 5, scope: 'run', ignoreTools: [] } };
const rec = (p: Partial<RecommendationDetail>): RecommendationDetail => ({
  id: 'pr_1', detector: 'review_tool_loops', agentId: 'lead-agent', source: 'production', cohort: 'c', action: 'review_tool_loops', status: 'open',
  verificationStatus: 'not_started', currentFindingId: 'pf_1', feedbackCount: 0, createdAt: '2026-11-01T12:00:00Z', updatedAt: '2026-11-01T12:00:00Z',
  measures: LOOPS, evidenceCount: 3, suggestedAction: loopRule, ...p,
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); api.governanceCreateRule.mockReset(); api.performanceRecommendationGet.mockReset(); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const card = (recs: RecommendationDetail[]) => act(() => root.render(h(RecommendationsCard, {
  recs, total: recs.length, status: 'all', onStatus: () => {}, showStatuses: false, onShowStatuses: () => {}, agentFilter: '', onAgentFilter: () => {},
  showAgentFilter: false, filtered: false, hasCalls: true, loading: false, error: null, notice: null, hasMore: false, onMore: () => {},
  onSelectAgent: () => {}, onSelectEvidence: () => {}, onFeedback: () => {}, onDiagnosisFeedback: async () => true, feedbackLoading: null, feedbackError: null,
})));
const links = () => [...host.querySelectorAll('a')].map((a) => `${a.textContent} → ${a.getAttribute('href')}`);
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label)!;

describe('a suggested rule on a recommendation row', () => {
  it('without a rule yet: offers Add … in Watch', () => {
    card([rec({})]);
    expect(links()).toEqual(['Add loop breaker in Watch → /controls?rec=pr_1']);
  });

  it('with a Watch rule: says what it would have done and links to the rule, with no second Add', () => {
    card([rec({ linkedRule: { id: 'gr_9', ruleType: 'loop_breaker', mode: 'watch', response: 'block', wouldAct: 7, acted: 0 } })]);
    expect(host.textContent).toContain('Loop breaker is in Watch. It would have acted 7 times in the last 7 days, and stopped none of them.');
    expect(links()).toEqual(['Open the rule → /controls?rule=gr_9']);
  });

  it('a linked rule is ignored on a row whose fix is a how-to, not a rule', () => {
    card([rec({ detector: 'review_tool_errors', measures: { toolName: 'fetch_page', toolErrors: 9, totalErrors: 9, totalResults: 30, errorRatePct: 30 }, suggestedAction: { kind: 'howto', howtoId: 'tool_errors' }, linkedRule: { id: 'gr_9', ruleType: 'loop_breaker', mode: 'watch', response: 'block', wouldAct: 7, acted: 0 } })]);
    expect(links()).toEqual([]);
    expect(host.textContent).not.toContain('is in Watch');
  });
});

describe('a fix check on a row', () => {
  const fix = (state: 'checking' | 'stopped' | 'still_happening') => ({ state, markedAt: '2026-11-01T12:00:00.000Z', resultAfter: '2026-11-08T12:00:00.000Z', before: { ...LOOPS, maxRepeats: 12 } });

  it('reopened: says it is still happening and what it said when marked', () => {
    card([rec({ verificationStatus: 'still_happening', fixCheck: fix('still_happening') })]);
    expect(host.textContent).toContain('but it is still happening.');
    expect(host.textContent).toContain('When it was marked fixed: search_places ran with the same request 12 times');
  });

  it('marked fixed and still being checked: no claim that it worked', () => {
    card([rec({ status: 'reported_implemented', verificationStatus: 'collecting', fixCheck: fix('checking') })]);
    expect(host.textContent).toContain('WhiteRoom checks it worked on');
    expect(host.textContent).not.toContain('It stopped');
    expect(host.textContent).not.toContain('When it was marked fixed');
  });

  it('an older row shows the line in place of a raw status, and keeps other verification badges', () => {
    const legacy = { detector: 'review_cache_behavior', measures: undefined, suggestedAction: undefined, summary: 'Caching may be off.' };
    card([rec({ ...legacy, status: 'reported_implemented', verificationStatus: 'stopped', fixCheck: fix('stopped') })]);
    expect(host.textContent).toContain('It stopped.');
    expect(host.textContent).not.toContain('stoppedMarked');
    card([rec({ ...legacy, verificationStatus: 'inconclusive' })]);
    expect(host.textContent).toContain('inconclusive');
    // No fix check sent (an engine that only has the status): the badge still says where it stands.
    card([rec({ ...legacy, verificationStatus: 'collecting' })]);
    expect(host.textContent).toContain('collecting');
  });
});

describe('the suggestion draft', () => {
  const loaded = { contractVersion: '1', recommendation: rec({}), finding: null };
  const draft = async (onDone = vi.fn(), onCancel = vi.fn()) => {
    api.performanceRecommendationGet.mockResolvedValue(loaded);
    await act(async () => { root.render(h(SuggestionDraft, { fleetId: 'f1', recId: 'pr_1', existingRule: null, onDone, onCancel })); });
    return { onDone, onCancel };
  };

  it('adds the rule and sends nothing else; the message says it stops nothing yet', async () => {
    api.governanceCreateRule.mockResolvedValue({ rule: { id: 'gr_1' } });
    const { onDone } = await draft();
    await act(async () => { button('Add in Watch').click(); });
    expect(api.governanceCreateRule).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith('gr_1', expect.stringContaining('It stops nothing yet.'));
  });

  it('an add that could not be confirmed offers Try again, and Cancel says the rule may exist', async () => {
    api.governanceCreateRule.mockRejectedValue(new Error('timeout'));
    const { onDone, onCancel } = await draft();
    await act(async () => { button('Add in Watch').click(); });
    expect(onDone).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Couldn't confirm the rule was added. Try again.");
    await act(async () => { button('Cancel').click(); });
    expect(onCancel).toHaveBeenCalledWith(true);
  });

  it('Cancel before any add says no rule was made', async () => {
    const { onCancel } = await draft();
    await act(async () => { button('Cancel').click(); });
    expect(onCancel).toHaveBeenCalledWith(false);
  });
});
