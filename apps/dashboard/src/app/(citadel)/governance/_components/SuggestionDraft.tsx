'use client';

/**
 * A draft rule from a Diagnosis suggestion (spec Rev 4.4 §6.3). The link
 * carries only `?rec=`; the suggestion is loaded here, so a stale or edited
 * link can't pre-fill wrong values. Nothing is created until the person
 * confirms, and the mode is fixed to Watch.
 */
import { useEffect, useState } from 'react';
import { governanceCreateRule, performanceFeedback, performanceRecommendationGet } from '@/lib/whiteroom/client';
import type { GovernanceParams, RecommendationDetail } from '@/lib/whiteroom/types';
import { addSuggestedRuleInWatch } from '@/lib/diagnosis/addInWatch';
import { findingSentence, sentenceText, isDiagnosisDetector, RULE_LABEL, RULE_TITLE, STATUS_LABEL } from '@/lib/diagnosis/copy';
import { MONO } from '@/lib/diagnosis/ui';

const REC_ID = /^[a-zA-Z0-9_-]{1,64}$/;

type RuleType = 'loop_breaker' | 'spend_cap';
type Loaded = { rec: RecommendationDetail; ruleType: RuleType; sentence: string; params: GovernanceParams; suggested: number };

// `max` matches the engine's own validation, so the limit shows here rather
// than as a failed request.
const FIELD: Record<RuleType, { label: string; key: 'threshold' | 'dailyCap'; suffix: string; max: number }> = {
  loop_breaker: { label: 'Same call repeated', key: 'threshold', suffix: 'times in one run', max: 10_000 },
  spend_cap: { label: 'Tokens per day', key: 'dailyCap', suffix: 'tokens a day', max: 1e12 },
};

const isRuleType = (v: unknown): v is RuleType => typeof v === 'string' && Object.hasOwn(FIELD, v);

const panel = { width: 420, borderLeft: '1px solid var(--line)', overflowY: 'auto', padding: 24, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 14 } as const;

export function SuggestionDraft({ fleetId, authKey, recId, onDone, onCancel }: {
  fleetId: string;
  authKey?: string;
  recId: string;
  onDone: (ruleId: string, message: string) => void;
  /** `ruleCreated`: the rule exists even though the draft is being closed. */
  onCancel: (ruleCreated: boolean) => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
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
        const rule = action?.kind === 'rule' ? action : null;
        const params = rule ? (rule.params as unknown as Record<string, unknown> | null) : null;
        const suggested = rule && params && isRuleType(rule.rule) ? params[FIELD[rule.rule].key] : undefined;
        if (!rec || !isDiagnosisDetector(rec.detector) || !rule || !isRuleType(rule.rule)
          || typeof suggested !== 'number' || !Number.isFinite(suggested) || suggested < 1) {
          setProblem('This suggestion can’t be added as a rule.');
          return;
        }
        const measures = (res.finding?.measures as Record<string, number | string> | undefined) ?? rec.measures ?? {};
        setLoaded({ rec, ruleType: rule.rule, sentence: sentenceText(findingSentence(rec.detector, measures)), params: params as unknown as GovernanceParams, suggested });
        setAmount(String(Math.round(suggested)));
      })
      .catch(() => { if (!cancelled) setProblem('Couldn’t load this suggestion. It may have expired.'); });
    return () => { cancelled = true; };
  }, [fleetId, authKey, recId]);

  if (problem) {
    return (
      <div className="gov-panel" style={panel}>
        <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Suggested rule</h2>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--tx2)' }}>{problem}</p>
        <button type="button" className="dx-link" onClick={() => onCancel(false)}>Close</button>
      </div>
    );
  }
  if (!loaded) {
    return <div className="gov-panel" style={panel}><p style={{ margin: 0, fontSize: 13, color: 'var(--tx2)' }}>Loading the suggestion…</p></div>;
  }

  const { rec, ruleType } = loaded;
  const field = FIELD[ruleType];
  const value = Math.round(Number(amount));
  const valid = Number.isFinite(value) && value >= 1 && value <= field.max;
  // Not an error: an extra digit is easy to type and quietly weakens the rule.
  const farAbove = valid && value > loaded.suggested * 10;

  const add = async () => {
    if (!valid || saving) return;
    setSaving(true);
    setFailure(null);
    const result = await addSuggestedRuleInWatch({
      createRule: (input) => governanceCreateRule(fleetId, input, authKey),
      markImplemented: (input) => performanceFeedback(fleetId, { ...input, action: 'implemented' }, authKey),
      reloadRecommendation: (id) => performanceRecommendationGet(fleetId, id, authKey),
    }, {
      recommendationId: rec.id,
      currentFindingId: rec.currentFindingId ?? '',
      status: rec.status,
      ruleType,
      params: { ...loaded.params, [field.key]: value } as GovernanceParams,
      agentId: rec.agentId,
      ruleId,
    });
    setSaving(false);
    if (result.ok) {
      onDone(result.ruleId, result.existing
        ? `This suggestion's ${RULE_LABEL[ruleType]} was already added in Watch for ${rec.agentId}.`
        : `${RULE_TITLE[ruleType]} added in Watch for ${rec.agentId}. You'll see what it would have caught in Runs.`);
    } else if (result.step === 'feedback') {
      setRuleId(result.ruleId);
      setFailure(`${RULE_TITLE[ruleType]} added in Watch. We couldn't mark the suggestion as done.`);
    } else {
      // A timeout can hide a rule the engine did create; retrying is safe either way.
      setFailure("Couldn't confirm the rule was added. Try again.");
    }
  };

  return (
    <section className="gov-panel" style={panel} aria-labelledby="suggestion-title">
      <h2 id="suggestion-title" style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>New {RULE_LABEL[ruleType]} from a suggestion</h2>
      <div style={{ background: 'var(--brand-dim)', border: '1px solid var(--brand)', borderRadius: 8, padding: '10px 12px', fontSize: 13, lineHeight: 1.5 }}>
        {rec.status === 'open'
          ? <><b style={{ color: 'var(--brand)' }}>Suggested for <span style={MONO}>{rec.agentId}</span>:</b> {loaded.sentence}</>
          : <>This suggestion is {STATUS_LABEL[rec.status] ?? rec.status}. You can still add the rule.</>}
      </div>
      <p style={{ margin: 0, fontSize: 12.5, color: 'var(--tx2)' }}>Watch mode records every time this rule would have stepped in. It doesn&apos;t block anything.</p>

      <dl style={{ display: 'grid', gridTemplateColumns: '140px minmax(0,1fr)', gap: '10px 14px', fontSize: 13, alignItems: 'center', margin: 0 }}>
        <dt style={{ color: 'var(--tx2)' }}>Rule</dt><dd style={{ margin: 0 }}>{RULE_TITLE[ruleType]}</dd>
        <dt style={{ color: 'var(--tx2)' }}>Applies to</dt><dd style={{ margin: 0, ...MONO }}>{rec.agentId}</dd>
        <dt style={{ color: 'var(--tx2)' }}><label htmlFor="suggestion-amount">{field.label}</label></dt>
        <dd style={{ margin: 0 }}>
          <input id="suggestion-amount" inputMode="numeric" value={amount} disabled={!!ruleId} aria-invalid={!valid}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))}
            style={{ ...MONO, width: 120, padding: '5px 8px', borderRadius: 6, border: `1px solid ${valid ? 'var(--line2)' : 'var(--bad)'}`, background: 'var(--sunk)', color: 'var(--tx)' }} />
          {' '}<span style={{ color: 'var(--tx2)', whiteSpace: 'nowrap' }}>{field.suffix}</span>
          {amount !== '' && !valid && <span style={{ display: 'block', fontSize: 12, color: 'var(--bad)', marginTop: 6 }}>Enter a whole number from 1 to {field.max.toLocaleString('en-US')}.</span>}
          {farAbove && <span style={{ display: 'block', fontSize: 12, color: 'var(--tx2)', marginTop: 6 }}>That&apos;s over 10× the suggested {loaded.suggested.toLocaleString('en-US')}.</span>}
        </dd>
        <dt style={{ color: 'var(--tx2)' }}>Mode</dt>
        <dd style={{ margin: 0 }}>
          <span role="group" aria-label="Mode" style={{ display: 'inline-flex', border: '1px solid var(--line2)', borderRadius: 6, overflow: 'hidden' }}>
            <button type="button" aria-pressed="true" style={{ padding: '5px 12px', fontSize: 12, fontWeight: 600, border: 0, background: 'var(--brand-dim)', color: 'var(--brand)' }}>Watch</button>
            <button type="button" disabled style={{ padding: '5px 12px', fontSize: 12, fontWeight: 600, border: 0, background: 'none', color: 'var(--tx3)', cursor: 'not-allowed' }}>Enforce</button>
          </span>
          <span style={{ display: 'block', fontSize: 12, color: 'var(--tx2)', marginTop: 6 }}>Switch to Enforce after you&apos;ve seen what it catches.</span>
        </dd>
      </dl>

      {failure && <div role="alert" style={{ fontSize: 12.5, color: 'var(--tx)', background: 'var(--bad-bg)', border: '1px solid var(--bad)', borderRadius: 8, padding: '8px 12px' }}>{failure}</div>}

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="dx-main-btn" disabled={saving || !valid} onClick={() => void add()} style={{
          fontSize: 13, fontWeight: 600, padding: '7px 16px', borderRadius: 6, border: '1px solid var(--brand)',
          background: 'var(--brand)', color: 'var(--bg)', cursor: saving ? 'wait' : 'pointer', opacity: saving || !valid ? 0.6 : 1,
        }}>{saving ? 'Adding…' : ruleId ? 'Try again' : 'Add in Watch'}</button>
        <button type="button" className="dx-link" onClick={() => onCancel(!!ruleId)}>Cancel</button>
      </div>
    </section>
  );
}
