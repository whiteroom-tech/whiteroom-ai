// Audit F13: with a 10s interval and 12s responses, every tick used to start
// a new sequence, so each response arrived stale and was dropped — the page
// never updated while requests piled up.

import { describe, it, expect } from 'vitest';
import { createPoller } from '@/hooks/usePoll';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('createPoller', () => {
  it('skips scheduled ticks while a poll is in flight, so a slow response still lands', async () => {
    const pending = deferred();
    const stales: Array<() => boolean> = [];
    let calls = 0;
    const poller = createPoller(() => (stale) => { calls++; stales.push(stale); return pending.promise; });

    poller.refresh();
    poller.tick();
    poller.tick();
    expect(calls).toBe(1);

    pending.resolve();
    await pending.promise;
    await Promise.resolve();
    expect(stales[0]()).toBe(false);

    poller.tick();
    expect(calls).toBe(2);
  });

  it('lets an explicit refresh supersede an in-flight poll', () => {
    const stales: Array<() => boolean> = [];
    const poller = createPoller(() => (stale) => { stales.push(stale); return new Promise<void>(() => {}); });

    poller.refresh();
    poller.refresh();
    expect(stales).toHaveLength(2);
    expect(stales[0]()).toBe(true);
    expect(stales[1]()).toBe(false);
  });

  it('marks everything stale once stopped', () => {
    const stales: Array<() => boolean> = [];
    const poller = createPoller(() => (stale) => { stales.push(stale); });
    poller.refresh();
    poller.stop();
    expect(stales[0]()).toBe(true);
  });
});
