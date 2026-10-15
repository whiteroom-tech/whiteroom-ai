import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const posthog = vi.hoisted(() => ({ init: vi.fn(), reset: vi.fn(), identify: vi.fn(), capture: vi.fn() }));
vi.mock('posthog-js', () => ({ default: posthog }));

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('analytics identity', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('window', { location: { pathname: '/home' } });
    Object.values(posthog).forEach((f) => f.mockClear());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("starts from the user's ID and keeps nothing in the browser", async () => {
    const { initAnalytics } = await import('@/lib/analytics');
    initAnalytics('user-1');
    await flush();
    expect(posthog.init).toHaveBeenCalledTimes(1);
    const opts = posthog.init.mock.calls[0][1];
    expect(opts.persistence).toBe('memory');
    expect(opts.bootstrap).toEqual({ distinctID: 'user-1', isIdentifiedID: true });
  });

  it('does nothing more for the same user, and starts over for another', async () => {
    const { initAnalytics } = await import('@/lib/analytics');
    initAnalytics('user-1');
    initAnalytics('user-1');
    await flush();
    expect(posthog.init).toHaveBeenCalledTimes(1);
    expect(posthog.reset).not.toHaveBeenCalled();

    initAnalytics('user-2');
    await flush();
    expect(posthog.init).toHaveBeenCalledTimes(1);
    expect(posthog.reset).toHaveBeenCalledWith({ bootstrap: { distinctID: 'user-2', isIdentifiedID: true } });
  });

  it('stays off without a signed-in user', async () => {
    const { initAnalytics } = await import('@/lib/analytics');
    initAnalytics('');
    await flush();
    expect(posthog.init).not.toHaveBeenCalled();
  });
});
