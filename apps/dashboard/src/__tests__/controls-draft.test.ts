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
