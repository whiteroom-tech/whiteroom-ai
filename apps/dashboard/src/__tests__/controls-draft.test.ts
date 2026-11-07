// @vitest-environment happy-dom
// The kept Controls draft: one per fleet, this tab only, and gone on every
// confirmed sign-out (clearSessionLocalState runs in whichever tab learns of it).
import { beforeEach, expect, it } from 'vitest';
import { clearDrafts, readDraft, removeDraft, writeDraft } from '@/lib/controls-draft';
import { clearSessionLocalState } from '@/lib/session-local-state';
import type { RuleDraft } from '@/lib/controls-view';

const draft = { ruleType: 'keyword', mode: 'watch', response: 'block', alsoNotify: false, appliesTo: 'all', params: { keywords: ['placeholder-term'], where: 'incoming' }, number: '' } as unknown as RuleDraft;

beforeEach(() => { sessionStorage.clear(); });

it('keeps one draft per fleet', () => {
  writeDraft('f1', { ruleId: 'r1', version: 3, draft });
  writeDraft('f2', { ruleId: 'r9', version: 1, draft });
  expect(readDraft('f1')).toMatchObject({ ruleId: 'r1', version: 3 });
  expect(readDraft('f2')).toMatchObject({ ruleId: 'r9' });
  removeDraft('f1');
  expect(readDraft('f1')).toBeNull();
  expect(readDraft('f2')).not.toBeNull();
});

it('a sign-out clears every fleet\'s draft, and nothing else', () => {
  writeDraft('f1', { ruleId: 'r1', version: 3, draft });
  writeDraft('f2', { ruleId: 'r9', version: 1, draft });
  sessionStorage.setItem('wr_runs_list_url', '/runs?range=30d');
  clearSessionLocalState();
  expect(readDraft('f1')).toBeNull();
  expect(readDraft('f2')).toBeNull();
  expect(sessionStorage.getItem('wr_runs_list_url')).toBe('/runs?range=30d');
  clearDrafts(); // nothing left: no error
});

it('a malformed entry reads as none', () => {
  sessionStorage.setItem('wr_controls_draft:f1', '{not json');
  expect(readDraft('f1')).toBeNull();
  sessionStorage.setItem('wr_controls_draft:f1', JSON.stringify({ ruleId: 'r1' }));
  expect(readDraft('f1')).toBeNull();
});

it.each([
  ['an empty draft', {}],
  ['no params', { ...draft, params: undefined }],
  ['params not an object', { ...draft, params: 'x' }],
  ['appliesTo of the wrong kind', { ...draft, appliesTo: 'some' }],
  ['a number that is not text', { ...draft, number: 100 }],
  ['keyword params missing their list', { ...draft, params: {} }],
  ['keywords as a string', { ...draft, params: { keywords: 'placeholder-term', where: 'incoming' } }],
  ['a keyword "where" this build doesn\'t know', { ...draft, params: { keywords: [], where: 'everywhere' } }],
  ['a spend cap with no unit', { ...draft, ruleType: 'spend_cap', params: { dailyCap: 5, scope: 'day' } }],
  ['a loop breaker whose ignore list isn\'t a list', { ...draft, ruleType: 'loop_breaker', params: { threshold: 5, scope: 'run', ignoreTools: 'x' } }],
  ['a rule type this build doesn\'t know', { ...draft, ruleType: 'mystery', params: {} }],
])('a draft the editor couldn\'t open (%s) reads as none', (_name, bad) => {
  sessionStorage.setItem('wr_controls_draft:f1', JSON.stringify({ ruleId: 'r1', version: 1, draft: bad }));
  expect(readDraft('f1')).toBeNull();
});

it.each([
  ['spend cap', { ruleType: 'spend_cap', params: { dailyCap: 5, scope: 'day', unit: 'dollars' } }],
  ['loop breaker', { ruleType: 'loop_breaker', params: { threshold: 5, scope: 'run', ignoreTools: [] } }],
  ['call rate', { ruleType: 'call_rate', params: { maxCalls: 60 } }],
  ['model allowlist', { ruleType: 'model_allowlist', params: { allowedModels: ['m'] } }],
  ['tool list', { ruleType: 'tool_list', params: { blockedTools: [] } }],
  ['keyword', { ruleType: 'keyword', params: { keywords: ['x'], where: 'both', wholeWord: true } }],
])('a well-formed %s draft reads back', (_name, shape) => {
  writeDraft('f1', { ruleId: 'r1', version: 1, draft: { ...draft, ...shape } as RuleDraft });
  expect(readDraft('f1')).not.toBeNull();
});
