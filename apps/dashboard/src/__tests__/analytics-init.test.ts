import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const posthog = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock('posthog-js', () => ({ default: posthog }));

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('initAnalytics', () => {
  beforeEach(() => {
    vi.resetModules();
    posthog.init.mockReset();
    vi.stubGlobal('window', { location: { pathname: '/home' } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('starts once, with the Sept 22 privacy settings', async () => {
    const { initAnalytics } = await import('@/lib/analytics');
    initAnalytics();
    initAnalytics();
    await flush();
    expect(posthog.init).toHaveBeenCalledTimes(1);
    expect(posthog.init.mock.calls[0][1]).toMatchObject({
      autocapture: false, capture_pageview: false, capture_pageleave: false,
      disable_session_recording: true, persistence: 'memory',
    });
  });

  it('retries on the next call when starting failed', async () => {
    const { initAnalytics } = await import('@/lib/analytics');
    posthog.init.mockImplementationOnce(() => { throw new Error('chunk failed'); });
    initAnalytics();
    await flush();
    initAnalytics();
    await flush();
    expect(posthog.init).toHaveBeenCalledTimes(2);
  });

  it('does nothing server-side', async () => {
    vi.stubGlobal('window', undefined);
    const { initAnalytics } = await import('@/lib/analytics');
    initAnalytics();
    await flush();
    expect(posthog.init).not.toHaveBeenCalled();
  });
});
