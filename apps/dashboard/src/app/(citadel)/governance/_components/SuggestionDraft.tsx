'use client';

/**
 * A draft rule from a Diagnosis suggestion (spec Rev 4.4 §6.3). The link
 * carries only `?rec=`; this panel loads the suggestion itself, so a stale or
 * edited link can't pre-fill wrong values. Nothing is created until the
 * person confirms, and the mode is fixed to Watch.
 */
import { useEffect, useState } from 'react';
import { FONT_MONO } from '@whiteroom/ui';
import { governanceCreateRule, performanceFeedback, performanceRecommendationGet } from '@/lib/whiteroom/client';
import type { GovernanceParams, GovernanceRule, RecommendationDetail } from '@/lib/whiteroom/types';
import { addSuggestedRuleInWatch } from '@/lib/diagnosis/addInWatch';
import { findingSentence, sentenceText, isDiagnosisDetector, RULE_LABEL, STATUS_LABEL } from '@/lib/diagnosis/copy';

const REC_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const MONO = { fontFamily: FONT_MONO, fontVariantNumeric: 'tabular-nums' } as const;

type Loaded = {
  rec: RecommendationDetail;
  ruleType: 'loop_breaker' | 'spend_cap';
  sentence: string;
};

export function SuggestionDraft({ fleetId, authKey, recId, onDone, onCancel }: {
  fleetId: string;
  authKey?: string;
  recId: string;
  onDone: (rule: GovernanceRule, message: string) => void;
  onCancel: () => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [params, setParams] = useState<GovernanceParams | null>(null);
  const [saving, setSaving] = useState(false);
  const [ruleId, setRuleId] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(null); setProblem(null); setRuleId(undefined); setFailure(null);
    if (!REC_ID.test(recId)) { setProblem('This link doesn’t point to a suggestion.'); return; }
    performanceRecommendationGet(fleetId, recId, authKey)
      .then((res) => {
        if (cancelled) return;
        const rec = res.recommendation;
        const action = rec?.suggestedAction;
        if (!rec || !isDiagnosisDetector(rec.detector) || action?.kind !== 'rule' || !['loop_breaker', 'spend_cap'].includes(action.rule)) {
          setProblem('This suggestion can’t be added as a rule.');
          return;
        }
        const measures = (res.finding?.measures as Record<string, number | string> | undefined) ?? rec.measures ?? {};
        setLoaded({ rec, ruleType: action.rule, sentence: sentenceText(findingSentence(rec.detector, measures)) });
        setParams(action.params as unknown as GovernanceParams);
      })
      .catch(() => { if (!cancelled) setProblem('Couldn’t load this suggestion. It may have expired.'); });
    return () => { cancelled = true; };
  }, [fleetId, authKey, recId]);

  const add = async () => {
    if (!loaded || !params) return;
    setSaving(true);
    setFailure(null);
    const label = RULE_LABEL[loaded.ruleType];
    const result = await addSuggestedRuleInWatch({
      createRule: (input) => governanceCreateRule(fleetId, input, authKey),
      markImplemented: (input) => performanceFeedback(fleetId, { ...input, action: 'implemented' }, authKey),
      reloadRecommendation: (id) => performanceRecommendationGet(fleetId, id, authKey),
    }, {
      recommendationId: loaded.rec.id,
      currentFindingId: loaded.rec.currentFindingId ?? '',
      status: loaded.rec.status,
      ruleType: loaded.ruleType,
      params,
      agentId: loaded.rec.agentId,
      ruleId,
    });
    setSaving(false);
    const Label = label.charAt(0).toUpperCase() + label.slice(1);
    if (result.ok) {
      onDone({ id: result.ruleId } as GovernanceRule, `${Label} added in Watch for ${loaded.rec.agentId}. You’ll see what it would have caught in Runs.`);
    } else if (result.step === 'feedback') {
      setRuleId(result.ruleId);
      setFailure(`${Label} added in Watch. We couldn’t mark the suggestion as done.`);
    } else {
      setFailure('Couldn’t add the rule. Nothing was created.');
    }
  };

  const panel = { width: 420, borderLeft: '1px solid var(--line)', overflowY: 'auto', padding: 24, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 14 } as const;

  if (problem) {
    return (
      <div style={panel}>
        <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Suggested rule</h2>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--tx2)' }}>{problem}</p>
        <button type="button" className="dx-link" onClick={onCancel}>Close</button>
      </div>
    );
  }
  if (!loaded || !params) {
    return <div style={panel}><p style={{ margin: 0, fontSize: 13, color: 'var(--tx2)' }}>Loading the suggestion…</p></div>;
  }

  const { rec, ruleType } = loaded;
  const open = rec.status === 'open';
  const numberField = ruleType === 'loop_breaker'
    ? { label: 'Same call repeated', key: 'threshold' as const, suffix: 'times in one run' }
    : { label: 'Tokens per day', key: 'dailyCap' as const, suffix: 'tokens a day' };
  const value = Number((params as unknown as Record<string, unknown>)[numberField.key] ?? 0);

  return (
    <div style={panel} aria-labelledby="suggestion-title">
      <h2 id="suggestion-title" style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>New {RULE_LABEL[ruleType]} from a suggestion</h2>
      <div style={{ background: 'var(--brand-dim)', border: '1px solid var(--brand)', borderRadius: 8, padding: '10px 12px', fontSize: 13, lineHeight: 1.5 }}>
        {open
          ? <><b style={{ color: 'var(--brand)' }}>Suggested for <span style={MONO}>{rec.agentId}</span>:</b> {loaded.sentence}</>
          : <>This suggestion is {STATUS_LABEL[rec.status] ?? rec.status}. You can still add the rule.</>}
      </div>
      <p style={{ margin: 0, fontSize: 12.5, color: 'var(--tx2)' }}>Watch mode records every time this rule would have stepped in. It doesn&apos;t block anything.</p>

      <dl style={{ display: 'grid', gridTemplateColumns: '140px minmax(0,1fr)', gap: '10px 14px', fontSize: 13, alignItems: 'center', margin: 0 }}>
        <dt style={{ color: 'var(--tx2)' }}>Rule</dt><dd style={{ margin: 0 }}>{RULE_LABEL[ruleType].charAt(0).toUpperCase() + RULE_LABEL[ruleType].slice(1)}</dd>
        <dt style={{ color: 'var(--tx2)' }}>Applies to</dt><dd style={{ margin: 0, ...MONO }}>{rec.agentId}</dd>
        <dt style={{ color: 'var(--tx2)' }}><label htmlFor="suggestion-number">{numberField.label}</label></dt>
        <dd style={{ margin: 0 }}>
          <input id="suggestion-number" type="number" min={1} value={value} disabled={!!ruleId}
            onChange={(e) => setParams({ ...params, [numberField.key]: Math.max(1, Math.round(Number(e.target.value) || 1)) } as GovernanceParams)}
            style={{ ...MONO, width: 120, padding: '5px 8px', borderRadius: 6, border: '1px solid var(--line2)', background: 'var(--sunk)', color: 'var(--tx)' }} />
          {' '}<span style={{ color: 'var(--tx2)' }}>{numberField.suffix}</span>
        </dd>
        <dt style={{ color: 'var(--tx2)' }}>Mode</dt>
        <dd style={{ margin: 0 }}>
          <span style={{ display: 'inline-flex', border: '1px solid var(--line2)', borderRadius: 6, overflow: 'hidden' }}>
            <span style={{ padding: '5px 12px', fontSize: 12, fontWeight: 600, background: 'var(--brand-dim)', color: 'var(--brand)' }}>Watch</span>
            <span aria-disabled="true" style={{ padding: '5px 12px', fontSize: 12, fontWeight: 600, color: 'var(--tx3)' }}>Enforce</span>
          </span>
          <span style={{ display: 'block', fontSize: 12, color: 'var(--tx2)', marginTop: 6 }}>Switch to Enforce after you&apos;ve seen what it catches.</span>
        </dd>
      </dl>

      {failure && <div role="alert" style={{ fontSize: 12.5, color: 'var(--tx)', background: 'var(--bad-bg)', border: '1px solid var(--bad)', borderRadius: 8, padding: '8px 12px' }}>{failure}</div>}

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="dx-main-btn" disabled={saving} onClick={() => void add()} style={{
          fontSize: 13, fontWeight: 600, padding: '7px 16px', borderRadius: 6, border: '1px solid var(--brand)',
          background: 'var(--brand)', color: 'var(--bg)', cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.6 : 1,
        }}>{saving ? 'Adding…' : ruleId ? 'Try again' : 'Add in Watch'}</button>
        <button type="button" className="dx-link" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
