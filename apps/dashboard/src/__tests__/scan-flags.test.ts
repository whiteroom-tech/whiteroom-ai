// Agent Health items 2 and 4, shown: their run flags, Unusual behaviour rows, check copy and evidence.
import { describe, expect, it } from 'vitest';
import { flagText, UNUSUAL_SIGNALS } from '@/lib/runs';
import { findingSentence, sentenceText, howtoParagraphs, notMeasuredShort } from '@/lib/diagnosis/copy';
import { evidenceHeader } from '@/lib/diagnosis/model';

describe('scan flags', () => {
  it('say what was seen, naming the tool', () => {
    expect(flagText({ signal: 'planted_instruction', tool: 'read_email' })).toBe('Suspicious instruction in a result from read_email');
    expect(flagText({ signal: 'done_after_failure', tool: 'upload_file' })).toBe('Said done after upload_file failed');
  });

  it('are measured Unusual behaviour signals', () => {
    expect(UNUSUAL_SIGNALS.filter((s) => s.key === 'planted_instruction' || s.key === 'done_after_failure').map((s) => s.measured)).toEqual([true, true]);
  });

  it('their checks read plainly, once or several times', () => {
    expect(sentenceText(findingSentence('review_planted_instruction', { times: 1, toolName: 'read_email', tools: 1 }))).toBe('A result from read_email looked like it was giving the agent instructions. Worth a look.');
    expect(sentenceText(findingSentence('review_planted_instruction', { times: 2, toolName: 'read_email', tools: 1 }))).toBe('A result from read_email looked like it was giving the agent instructions. This happened 2 times this week. Worth a look.');
    expect(sentenceText(findingSentence('review_done_after_failure', { times: 3, toolName: 'upload_file' }))).toBe('It reported success right after a step failed, 3 times this week. Worth a look.');
    expect(howtoParagraphs('planted_instruction', { toolName: 'read_email' })[0]).toContain('read_email');
    expect(howtoParagraphs('done_after_failure', { toolName: 'upload_file' })).toEqual([
      'Open the calls to see what failed in upload_file and what the agent said after.',
      'Have the agent check a step worked before it reports the job done.',
    ]);
    expect(notMeasuredShort('scan_off', 'This check isn’t turned on for this engine')).toBe('switched off on this engine');
  });

  it('their evidence tables show the calls, with a dash or (none) when a list is empty', () => {
    const calls = [{ requestEnd: '2026-11-10T14:02:00Z', watchNumber: 4, requestedToolNames: ['read_email'], toolErrorNames: ['upload_file'] }, { requestEnd: '2026-11-10T13:00:00Z', watchNumber: 3 }];
    const p = evidenceHeader('review_planted_instruction', calls, { toolName: 'read_email' });
    expect(p).toMatchObject({ kind: 'table', columns: ['Time', 'Run', 'Called'] });
    expect(p?.kind === 'table' && p.rows.map((r) => r.slice(1))).toEqual([['4', 'read_email'], ['3', '(none)']]);
    const d = evidenceHeader('review_done_after_failure', calls, { toolName: 'upload_file' });
    expect(d).toMatchObject({ kind: 'table', columns: ['Time', 'Run', 'Reported errors'] });
    expect(d?.kind === 'table' && d.rows.map((r) => r.slice(1))).toEqual([['4', 'upload_file'], ['3', '—']]);
  });
});
