import { describe, it, expect } from 'vitest';
import {
  agentGets, draftFrom, draftProblem, isStopping, responseChoicesFor, responseOption, RULE_TEMPLATES, ruleConditionText, ruleSentenceText, ruleStatus,
  rowCount, sendsAlert, weakenings, whatHappensLine,
} from '@/lib/controls-view';
import { canAct } from '@/lib/controls-guard';
import { blockedByPhrase, governanceCounts, PAUSED_BY_WHITEROOM, RESPONSE_LABEL, sensitiveDataPaused } from '@/lib/governance';
import { eventModel, sensitiveCounts } from '@/lib/activity';
import { modeTagText } from '@/lib/vocab';
import type { AuditEntry, GovernanceRule, SensitiveDataParams } from '@/lib/whiteroom/types';

const sd = (over: Partial<GovernanceRule> & { params?: SensitiveDataParams } = {}): GovernanceRule => ({
  id: 's1', fleetId: 'f', ruleType: 'sensitive_data', mode: 'watch', response: 'redact', appliesTo: 'all', version: 1, changedBy: 't', changedAt: '2026-11-03T00:00:00Z',
  params: { detect: ['credentials', 'contact', 'ids'] }, ...over,
});

describe('Sensitive data in plain words', () => {
  it('reads as one sentence, naming what it looks for', () => {
    expect(ruleSentenceText(sd())).toBe('When a call holds keys and passwords, emails and phone numbers or ID and card numbers, it would remove it and send the call.');
    expect(ruleSentenceText(sd({ mode: 'enforce', response: 'notify', params: { detect: ['contact'] } }))).toBe('When a call holds emails and phone numbers, remove it, send the call and alert you.');
    expect(ruleConditionText(sd({ params: { detect: ['credentials'] } }))).toBe('A call holds keys and passwords');
  });

  it('offers Remove it and send first, never Block; Pause and Stop only on Gov v1 fleets', () => {
    expect(responseChoicesFor('sensitive_data', true)).toEqual(['redact', 'notify', 'pause', 'stop']);
    expect(responseChoicesFor('sensitive_data', false)).toEqual(['redact', 'notify']);
    expect(responseChoicesFor('sensitive_data', false, 'pause')).toEqual(['redact', 'notify', 'pause']);
    expect(responseChoicesFor('keyword', true)).toEqual(['block', 'pause', 'stop', 'notify']);
    expect(responseOption('sensitive_data', 'redact', RESPONSE_LABEL)).toBe('Remove it and send');
    expect(responseOption('sensitive_data', 'notify', RESPONSE_LABEL)).toBe('Remove it, send, and tell me');
    expect(responseOption('keyword', 'notify', RESPONSE_LABEL)).toBe(RESPONSE_LABEL.notify);
  });

  it('says what each mode does: Watch removes nothing', () => {
    const d = draftFrom(sd());
    expect(whatHappensLine(d)).toBe('Watch: records what it finds and removes nothing; every call goes through.');
    expect(whatHappensLine({ ...d, mode: 'enforce' })).toBe('Enforce: removes what it finds, then sends the call. The agent keeps going.');
    expect(whatHappensLine({ ...d, mode: 'enforce', response: 'notify' })).toBe('Enforce: removes what it finds, sends the call and alerts you.');
    expect(whatHappensLine({ ...d, mode: 'enforce', response: 'pause' })).toMatch(/^Enforce: removes what it finds and pauses the agent the first time something new turns up/);
  });

  it('Remove it and send neither alerts nor stops calls, and doesn’t make callers name themselves', () => {
    expect(sendsAlert({ mode: 'enforce', response: 'redact', alsoNotify: false })).toBe(false);
    expect(sendsAlert({ mode: 'enforce', response: 'notify', alsoNotify: false })).toBe(true);
    expect(isStopping(sd({ mode: 'enforce' }))).toBe(false);
    expect(isStopping(sd({ mode: 'enforce', response: 'pause' }))).toBe(true);
    expect(canAct(sd({ mode: 'enforce', response: 'stop' }))).toBe(false);
    expect(modeTagText(sd({ mode: 'enforce' }))).toBe('Enforce · removes');
  });

  it('needs something to look for', () => {
    expect(draftProblem({ ...draftFrom(sd()), params: { detect: [] } })).toBe('Pick at least one kind of data to look for.');
    expect(draftProblem(draftFrom(sd()))).toBeNull();
    // A rule from an engine that didn't send a response defaults to Remove it and send.
    expect(draftFrom({ ...sd(), response: undefined }).response).toBe('redact');
  });

  it('what the agent gets: the call goes through with markers, never what was found', () => {
    expect(agentGets(sd())).toBe('The call goes through with each find replaced:\n[redacted:credential:…]');
    expect(agentGets(sd({ response: 'pause' }))).toMatch(/^403 governance_block\nresponse: pause\nreason: sensitive_data_found/);
  });

  it('asks before weakening: fewer kinds, or a lost alert', () => {
    expect(weakenings(sd({ mode: 'enforce' }), sd({ mode: 'enforce', params: { detect: ['credentials'] } }))).toEqual(['No longer looks for emails and phone numbers or ID and card numbers']);
    expect(weakenings(sd({ mode: 'enforce', response: 'notify' }), sd({ mode: 'enforce' }))).toEqual(['It stops sending you an alert']);
    expect(weakenings(sd({ mode: 'enforce' }), sd({ mode: 'enforce', response: 'notify' }))).toEqual([]);
  });

  it('claims no count for Remove it and send, which records no rule action', () => {
    const week = { blocked: 0, paused: 0, stopped: 0, toldYou: 0, wouldAct: 0 };
    expect(rowCount(sd({ mode: 'enforce' }), { byRuleId: { s1: week }, onlyOfItsType: true })).toEqual({ text: '', tone: 'plain' });
    expect(ruleStatus(sd({ mode: 'enforce' }), { week })).toBe('Removing sensitive data for all agents');
    expect(ruleStatus(sd({ mode: 'enforce', response: 'notify' }), { week: { ...week, toldYou: 2 } })).toBe('Alerting you for all agents · 2 alerts in 7 days');
  });

  it('is offered as a new rule, and reads in the activity feed', () => {
    expect(RULE_TEMPLATES.find((t) => t.type === 'sensitive_data')).toMatchObject({ title: 'Keep sensitive data out', isNew: true });
    expect(blockedByPhrase('sensitive_data', 'sensitive_data_found', true)).toBe('the Sensitive data rule');
  });

  it('reads the engine’s switch from one field', () => {
    expect(sensitiveDataPaused({ sensitiveDataPaused: true })).toBe(true);
    expect(sensitiveDataPaused({})).toBe(false);
    expect(PAUSED_BY_WHITEROOM).toBe('Paused by WhiteRoom');
  });
});

describe('governance_sensitive_data events: counts only', () => {
  const ev = (over: Record<string, unknown>): AuditEntry => ({ id: 'e1', timestamp: '2026-11-03T12:00:00Z', type: 'governance_sensitive_data', agentId: 'lead-agent', ruleType: 'sensitive_data', ...over });

  it('says what was removed, from whose text, and what Watch found', () => {
    expect(eventModel(ev({ mode: 'enforce', response: 'redact', counts: { credential: 2, contact: 1, ids: 0 }, source: 'agent' })).said)
      .toBe('had 2 keys or passwords and 1 email or phone number removed before the call reached the model provider');
    expect(eventModel(ev({ mode: 'enforce', counts: { contact: 1 }, source: 'whiteroom', occurrences: 3 })).said)
      .toBe('had 1 email or phone number removed from text WhiteRoom added to its call ×3');
    expect(eventModel(ev({ mode: 'watch', counts: { ids: 1 } })).said).toBe('sent 1 ID or card number to the model provider (Watch: nothing removed)');
  });

  it('never prints anything but counts, and survives a malformed payload', () => {
    expect(sensitiveCounts({ credential: 'sk-ant-secret', contact: -1 })).toBe('sensitive data');
    expect(sensitiveCounts(null)).toBe('sensitive data');
    expect(sensitiveCounts({ credential: 1, contact: 2, ids: 3 })).toBe('1 key or password, 2 emails or phone numbers and 3 ID or card numbers');
  });

  it('isn’t counted as a block or a would-block', () => {
    const c = governanceCounts([ev({ mode: 'enforce', counts: { credential: 1 } })]);
    expect(c.blocks + c.wouldBlocks).toBe(0);
    expect(c.byRule.sensitive_data).toEqual({ blocks: 0, wouldBlocks: 0 });
  });
});
