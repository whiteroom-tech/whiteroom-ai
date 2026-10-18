// The rotation dialog's decisions, and the shown-once banner (P0 #1).
import { describe, expect, it, vi } from 'vitest';

// The server actions (and next-auth behind them) aren't needed to render.
vi.mock('@/lib/owner-credentials', () => ({ rotateApiKey: vi.fn(), replaceProxyUrls: vi.fn() }));
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { attempt, canConfirm, dialogReducer, INITIAL_DIALOG, nextStep, RotationResult } from '@/app/fleet-key/rotate';

const CLOUD = [{ prefix: 'sk-wr-dddddddddddddddd', provider: 'bedrock-sigv4', keyHint: 'none', cloudIdentity: true }];
const KEY = { prefix: 'sk-wr-aaaaaaaaaaaaaaaa', provider: 'anthropic', keyHint: 'abcd', cloudIdentity: false, wrKey: 'sk-wr-' + 'a'.repeat(40) };

describe('nextStep', () => {
  it('finishes on success, asks for consent once for cloud-identity keys, and shows any other refusal', () => {
    const done = { ok: true as const, proxyKeys: [], disconnected: [] };
    expect(nextStep(done, false)).toEqual({ step: 'done', result: done });
    expect(nextStep({ ok: false, error: 'confirm', cloudIdentityKeys: CLOUD }, false)).toEqual({ step: 'consent', keys: CLOUD });
    // Consent already given: the refusal is shown, not asked again.
    expect(nextStep({ ok: false, error: 'confirm', cloudIdentityKeys: CLOUD }, true)).toEqual({ step: 'error', error: 'confirm' });
    expect(nextStep({ ok: false, error: 'Only this fleet’s owner…' }, false)).toEqual({ step: 'error', error: 'Only this fleet’s owner…' });
    expect(nextStep({ ok: false, error: 'unconfirmed', unconfirmedApiKey: 'sk-wr-x' }, false)).toEqual({ step: 'error', error: 'unconfirmed', unconfirmedApiKey: 'sk-wr-x' });
  });
});

describe('the dialog’s flow', () => {
  it('first try without consent; on cloud-identity keys, asks; the second try reissues them and finishes', async () => {
    const done = { ok: true as const, apiKey: 'sk-wr-new', proxyKeys: [], disconnected: [] };
    const rotateApiKey = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: 'confirm', cloudIdentityKeys: CLOUD })
      .mockResolvedValueOnce(done);
    const replaceProxyUrls = vi.fn();
    expect(await attempt('api-key', false, { rotateApiKey, replaceProxyUrls })).toEqual({ step: 'consent', keys: CLOUD });
    expect(await attempt('api-key', true, { rotateApiKey, replaceProxyUrls })).toEqual({ step: 'done', result: done });
    expect(rotateApiKey.mock.calls.map(([i]) => i.reissueCloudIdentityKeys)).toEqual([false, true]);
    expect(replaceProxyUrls).not.toHaveBeenCalled();
  });

  it('Replace URLs calls the replace action only', async () => {
    const rotateApiKey = vi.fn();
    const replaceProxyUrls = vi.fn().mockResolvedValue({ ok: false, error: 'restarting' });
    expect(await attempt('proxy-urls', false, { rotateApiKey, replaceProxyUrls })).toEqual({ step: 'error', error: 'restarting' });
    expect(rotateApiKey).not.toHaveBeenCalled();
  });
});

describe('the dialog’s state', () => {
  const unconfirmed = { step: 'error' as const, error: 'didn’t confirm', unconfirmedApiKey: 'sk-wr-maybe' };

  it('an unconfirmed key after cloud consent lands on the main dialog, with retry off', () => {
    let s = dialogReducer(INITIAL_DIALOG, { type: 'answer', next: { step: 'consent', keys: CLOUD } });
    expect(s.cloudKeys).toEqual(CLOUD);
    s = dialogReducer(dialogReducer(s, { type: 'start' }), { type: 'answer', next: unconfirmed });
    expect(s).toEqual({ cloudKeys: null, error: 'didn’t confirm', unconfirmedKey: 'sk-wr-maybe' });
    expect(canConfirm(s, false)).toBe(false);
  });

  it('keeps the unconfirmed key through close, start and another answer', () => {
    let s = dialogReducer(INITIAL_DIALOG, { type: 'answer', next: unconfirmed });
    for (const e of [{ type: 'close' }, { type: 'start' }, { type: 'unreachable' }, { type: 'answer', next: { step: 'error', error: 'x' } }] as const) {
      s = dialogReducer(s, e);
      expect(s.unconfirmedKey).toBe('sk-wr-maybe');
      expect(canConfirm(s, false)).toBe(false);
    }
  });

  it('without an unconfirmed key, close resets and confirm is allowed when not busy', () => {
    const s = dialogReducer(INITIAL_DIALOG, { type: 'answer', next: { step: 'error', error: 'refused' } });
    expect(s.error).toBe('refused');
    expect(canConfirm(s, false)).toBe(true);
    expect(canConfirm(s, true)).toBe(false);
    expect(dialogReducer(s, { type: 'close' })).toEqual(INITIAL_DIALOG);
  });
});

describe('RotationResult', () => {
  const html = (r: Parameters<typeof RotationResult>[0]['result']) => renderToStaticMarkup(createElement(RotationResult, { result: r, onDismiss: () => {} }));

  it('shows each new proxy URL and its environment line, and the key without printing it', () => {
    const out = html({ ok: true, apiKey: 'sk-wr-' + 'b'.repeat(64), proxyKeys: [KEY], disconnected: [] });
    expect(out).toContain(`https://proxy.whiteroom.tech/${KEY.wrKey}`);
    expect(out).toContain('ANTHROPIC_BASE_URL');
    expect(out).toContain('New API key (hidden)');
    expect(out).not.toContain('b'.repeat(64));
    expect(out).toContain('I’ve copied them');
  });

  it('when the key couldn’t be saved, says it’s the only copy and offers no dismiss (a reload would lose it)', () => {
    const out = html({ ok: true, apiKey: 'sk-wr-' + 'c'.repeat(64), proxyKeys: [], disconnected: [], notSaved: true });
    expect(out).toContain('only copy');
    expect(out).not.toContain('I’ve copied them');
  });

  it('says when the new URLs were lost', () => {
    expect(html({ ok: true, apiKey: 'sk-wr-x', proxyKeys: [], disconnected: [], proxyKeysLost: true })).toContain('Replace the URLs again');
  });
});
