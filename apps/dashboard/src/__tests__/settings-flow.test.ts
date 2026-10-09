import { describe, it, expect } from 'vitest';
import { applyChange, changedElsewhere, CHANGED_ELSEWHERE, CHANGED_ELSEWHERE_CHECK, CHANGED_ELSEWHERE_RELOAD, CHANGED_ELSEWHERE_RETRY, conflictMessage, confirmKind, loadOptional, NOT_APPLIED, mergeSettingsReply } from '@/lib/settings-flow';
import { ControlDeniedError, WhiteRoomApiError } from '@/lib/whiteroom/client';

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

describe('loading an optional panel', () => {
  it('shows what the engine returned', async () => {
    expect(await loadOptional(async () => ({ ok: 1 }))).toEqual({ kind: 'loaded', value: { ok: 1 } });
  });

  it('stays hidden on an engine without the action, or for a viewer it refuses', async () => {
    expect(await loadOptional(async () => null)).toEqual({ kind: 'hidden' });
    expect(await loadOptional(async () => { throw new ControlDeniedError('Only the fleet owner can see this.'); })).toEqual({ kind: 'hidden' });
  });

  it('stays hidden when the session was rejected, since trying again can’t help', async () => {
    expect(await loadOptional(async () => { throw new WhiteRoomApiError('No fleet session', 401); })).toEqual({ kind: 'hidden' });
    expect(await loadOptional(async () => { throw new WhiteRoomApiError('Forbidden', 403); })).toEqual({ kind: 'hidden' });
    expect(await loadOptional(async () => { throw new WhiteRoomApiError('Bad gateway', 502); })).toEqual({ kind: 'failed' });
  });

  it('reports a network or server failure instead of hiding', async () => {
    expect(await loadOptional(async () => { throw new TypeError('Failed to fetch'); })).toEqual({ kind: 'failed' });
    expect(await loadOptional(async () => { throw new Error('HTTP 502'); })).toEqual({ kind: 'failed' });
  });
});

describe('a change someone else beat', () => {
  it('is recognised from the engine’s 409 wording, goal or rule', () => {
    expect(changedElsewhere('This goal was changed elsewhere. Reload and try again.')).toBe(true);
    expect(changedElsewhere('Rule was changed elsewhere. Reload and try again.')).toBe(true);
    expect(changedElsewhere(NOT_APPLIED)).toBe(false);
    expect(changedElsewhere('HTTP 503')).toBe(false);
  });
});

describe('the note after a goal change someone else beat', () => {
  it('keeps the user’s text for a save, asks to check for a clear, and asks for a reload if the re-read failed', () => {
    expect(conflictMessage(true, 'save')).toBe(CHANGED_ELSEWHERE);
    expect(conflictMessage(true, 'clear')).toBe(CHANGED_ELSEWHERE_CHECK);
    expect(conflictMessage(false, 'save')).toBe(CHANGED_ELSEWHERE_RELOAD);
    expect(conflictMessage(false, 'clear')).toBe(CHANGED_ELSEWHERE_RELOAD);
    expect(CHANGED_ELSEWHERE_CHECK).not.toMatch(/your text/i);
    expect(conflictMessage(true, 'run')).toBe(CHANGED_ELSEWHERE_RETRY); // no editor open: nothing "shown above"
    expect(CHANGED_ELSEWHERE_RETRY).not.toMatch(/above/i);
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

describe('confirming a shorter retention', () => {
  it('asks before shortening how long notes are kept, never before lengthening it', () => {
    const now = { handover_persistence: true, content_capture: true, personal_data: 'keep' as const, handover_max_age_hours: 72 };
    expect(confirmKind({ handover_max_age_hours: 24 }, now)).toBe('shorterRetention');
    expect(confirmKind({ handover_max_age_hours: 168 }, now)).toBeNull();
    expect(confirmKind({ handover_max_age_hours: 24 }, null)).toBeNull(); // nothing known to delete
  });
});
