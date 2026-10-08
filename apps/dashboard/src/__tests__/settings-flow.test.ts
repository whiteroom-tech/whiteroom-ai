import { describe, it, expect } from 'vitest';
import { applyChange, confirmKind, NOT_APPLIED, mergeSettingsReply } from '@/lib/settings-flow';

describe('applying a settings change', () => {
  it('returns what the engine applied', async () => {
    expect(await applyChange(async () => ({ ok: 1 }), () => true)).toEqual({ kind: 'applied', value: { ok: 1 } });
  });

  it('never treats an unapplied change as saved', async () => {
    expect(await applyChange(async () => null, () => true)).toEqual({ kind: 'failed', message: NOT_APPLIED });
    expect(await applyChange(async () => ({ success: false }), () => true, (r) => r.success)).toEqual({ kind: 'failed', message: NOT_APPLIED });
  });

  it('reports the engine’s refusal as written', async () => {
    expect(await applyChange(async () => { throw new Error('Only this fleet’s owner can change its controls and settings.'); }, () => true))
      .toEqual({ kind: 'failed', message: 'Only this fleet’s owner can change its controls and settings.' });
  });

  it('drops the result, success or failure, when the user moved to another fleet meanwhile', async () => {
    let current = 'a';
    const out = applyChange(async () => { current = 'b'; return { ok: 1 }; }, () => current === 'a');
    expect(await out).toEqual({ kind: 'stale' });
    current = 'a';
    expect(await applyChange(async () => { current = 'b'; throw new Error('x'); }, () => current === 'a')).toEqual({ kind: 'stale' });
  });
});

describe('which data setting changes ask first', () => {
  it('asks before deleting or removing, never before turning something back on', () => {
    expect(confirmKind({ handover_persistence: false })).toBe('notesOff');
    expect(confirmKind({ content_capture: false })).toBe('feedOff');
    expect(confirmKind({ personal_data: 'exclude' })).toBe('removePersonal');
    expect(confirmKind({ handover_persistence: true })).toBeNull();
    expect(confirmKind({ content_capture: true })).toBeNull();
    expect(confirmKind({ personal_data: 'keep' })).toBeNull();
  });
});

describe('mergeSettingsReply', () => {
  it('lays the reply over what was shown, without its success flag', () => {
    const prev = { handover_persistence: true, content_capture: true, personal_data: 'keep' as const };
    expect(mergeSettingsReply(prev, { content_capture: false, success: true })).toEqual({ ...prev, content_capture: false });
    expect(mergeSettingsReply<{ content_capture: boolean }>(null, { content_capture: false, success: true })).toEqual({ content_capture: false });
  });
});
