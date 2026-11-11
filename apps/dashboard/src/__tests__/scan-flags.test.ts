// Agent Health items 2 and 4, shown: their run flags and Unusual behaviour rows.
import { describe, expect, it } from 'vitest';
import { flagText, UNUSUAL_SIGNALS } from '@/lib/runs';
import { findingSentence, sentenceText, howtoParagraphs, notMeasuredShort } from '@/lib/diagnosis/copy';

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
    expect(sentenceText(findingSentence('review_done_after_failure', { times: 3, toolName: 'upload_file' }))).toBe('It reported success right after a step failed, 3 times this week. Worth a look.');
    expect(howtoParagraphs('planted_instruction', { toolName: 'read_email' })[0]).toContain('read_email');
    expect(notMeasuredShort('scan_off', 'This check isn’t turned on for this engine')).toBe('switched off on this engine');
  });
});
