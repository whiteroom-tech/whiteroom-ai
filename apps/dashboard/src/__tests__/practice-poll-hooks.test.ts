// @vitest-environment happy-dom
// The practice pages' shared poll and clock (usePracticePoll, useClock): 5 s
// while visible and none while hidden, one read at a time, a read at once on
// coming back, 'stop' ends it, a refusal that asking again won't fix goes to
// onError once and stops, a network blip keeps polling, a read answered after
// the page is left goes nowhere, and the clock starts at now.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { usePracticePoll, useClock, PRACTICE_POLL_MS } = await import('@/components/sandbox/practice/usePracticePoll');

const RUN = 'r-00000000-0000-4000-8000-0000000000cc';
let root: Root;
let answer: () => Response;
const fetchMock = vi.fn();
const reads = () => fetchMock.mock.calls.length;
let hidden = false;
beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  answer = () => Response.json({ id: RUN, lifecycle: 'active' });
  fetchMock.mockReset().mockImplementation(async () => answer());
  vi.stubGlobal('fetch', fetchMock);
  root = createRoot(document.body.appendChild(document.createElement('div')));
});
afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); vi.useRealTimers(); });

const Poll = (p: { onRead: (r: { lifecycle: string }) => 'stop' | void; onError: (e: unknown) => void }) => {
  usePracticePoll({ fleet: 'prod-eu', runId: RUN, enabled: true, onRead: p.onRead as never, onError: p.onError });
  return null;
};
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe('usePracticePoll', () => {
  it('reads every 5 s while visible, not at all while hidden, and at once on coming back', async () => {
    await act(async () => { root.render(h(Poll, { onRead: () => {}, onError: () => {} })); });
    await tick(PRACTICE_POLL_MS.visible);
    expect(reads()).toBe(1);
    await tick(PRACTICE_POLL_MS.visible);
    expect(reads()).toBe(2);
    hidden = true;
    await tick(PRACTICE_POLL_MS.visible);
    expect(reads()).toBe(2);
    await tick(60_000);
    expect(reads()).toBe(2);
    hidden = false;
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(reads()).toBe(3);
    await tick(PRACTICE_POLL_MS.visible);
    expect(reads()).toBe(4);
  });

  it('one read at a time: coming back while a read is on its way doesn’t start another', async () => {
    let release = () => {};
    answer = () => { throw new Error('unused'); };
    fetchMock.mockImplementation(() => new Promise<Response>((r) => { release = () => r(Response.json({ id: RUN, lifecycle: 'active' })); }));
    await act(async () => { root.render(h(Poll, { onRead: () => {}, onError: () => {} })); });
    await tick(PRACTICE_POLL_MS.visible);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(reads()).toBe(1);
    await act(async () => { release(); });
  });

  it('stops once onRead says so', async () => {
    await act(async () => { root.render(h(Poll, { onRead: () => 'stop' as const, onError: () => {} })); });
    await tick(PRACTICE_POLL_MS.visible * 4);
    expect(reads()).toBe(1);
  });

  it('a refusal asking again won’t fix: onError once, then no more reads; a server error keeps polling', async () => {
    const onError = vi.fn();
    answer = () => Response.json({ error: 'Not your test.' }, { status: 403 });
    await act(async () => { root.render(h(Poll, { onRead: () => {}, onError })); });
    await tick(PRACTICE_POLL_MS.visible * 4);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(reads()).toBe(1);
    act(() => root.unmount());
    root = createRoot(document.body.appendChild(document.createElement('div')));
    fetchMock.mockClear();
    const onError2 = vi.fn();
    answer = () => Response.json({ error: 'down' }, { status: 503 });
    await act(async () => { root.render(h(Poll, { onRead: () => {}, onError: onError2 })); });
    await tick(PRACTICE_POLL_MS.visible * 3);
    expect(onError2).not.toHaveBeenCalled();
    expect(reads()).toBe(3);
  });

  it('a network blip (no answer at all) keeps polling, without onError', async () => {
    const onError = vi.fn();
    fetchMock.mockImplementation(async () => { throw new TypeError('Failed to fetch'); });
    await act(async () => { root.render(h(Poll, { onRead: () => {}, onError })); });
    await tick(PRACTICE_POLL_MS.visible * 3);
    expect(onError).not.toHaveBeenCalled();
    expect(reads()).toBe(3);
  });

  it('leaving the page mid-read: the late answer never reaches onRead, and no more reads', async () => {
    let release = () => {};
    const onRead = vi.fn();
    fetchMock.mockImplementation(() => new Promise<Response>((r) => { release = () => r(Response.json({ id: RUN, lifecycle: 'active' })); }));
    await act(async () => { root.render(h(Poll, { onRead, onError: () => {} })); });
    await tick(PRACTICE_POLL_MS.visible);
    expect(reads()).toBe(1);
    act(() => root.unmount());
    await act(async () => { release(); });
    await tick(PRACTICE_POLL_MS.visible * 3);
    expect(onRead).not.toHaveBeenCalled();
    expect(reads()).toBe(1);
    root = createRoot(document.body.appendChild(document.createElement('div')));
  });
});

describe('useClock', () => {
  it('starts at now when enabled, not when the page opened, and pauses while hidden', async () => {
    let now = 0;
    const Clock = ({ on }: { on: boolean }) => { now = useClock(on, 1_000); return null; };
    await act(async () => { root.render(h(Clock, { on: false })); });
    expect(now).toBe(1_000);
    await act(async () => { root.render(h(Clock, { on: true })); });
    expect(now).toBe(Date.now());
    hidden = true;
    const before = now;
    await tick(3_000);
    expect(now).toBe(before);
  });
});
