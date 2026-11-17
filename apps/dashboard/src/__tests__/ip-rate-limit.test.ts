import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '@/proxy';
import { clientIp, trustedProxyHops } from '@/lib/client-ip';
import {
  DEFAULT_IP_REQUESTS_PER_MINUTE, MAX_TRACKED, _resetIpRateLimit, ipRequestsPerMinute, takeIpRequest,
} from '@/lib/ip-rate-limit';

const MIN = 60_000;
// The start of a minute, so window arithmetic in the tests is exact.
const T0 = 1_800_000_000_000 - (1_800_000_000_000 % MIN);

beforeEach(() => _resetIpRateLimit());
afterEach(() => {
  delete process.env.IP_REQUESTS_PER_MINUTE;
  delete process.env.TRUSTED_PROXY_HOPS;
});

describe('clientIp', () => {
  it('behind the load balancer (1 hop) takes the entry before the load balancer', () => {
    expect(clientIp('6.6.6.6, 203.0.113.7, 198.51.100.1', 1)).toBe('203.0.113.7');
  });

  it('without a load balancer (0 hops) takes the last entry, so a written-in address is ignored', () => {
    expect(clientIp('6.6.6.6, 203.0.113.7', 0)).toBe('203.0.113.7');
    expect(clientIp('203.0.113.7', 0)).toBe('203.0.113.7');
  });

  it('with fewer entries than hops falls back to the first, and to empty with no header', () => {
    expect(clientIp('203.0.113.7', 1)).toBe('203.0.113.7');
    expect(clientIp(null, 1)).toBe('');
    expect(clientIp(' , ', 0)).toBe('');
  });

  it('reads TRUSTED_PROXY_HOPS, defaulting to 1 for anything not 0–3', () => {
    expect(trustedProxyHops({})).toBe(1);
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: '0' })).toBe(0);
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: '2' })).toBe(2);
    for (const bad of ['', '-1', '4', '1.5', 'zero']) expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: bad })).toBe(1);
  });
});

describe('ipRequestsPerMinute', () => {
  it('defaults to 1000, takes whole numbers, and 0 turns the limit off', () => {
    expect(ipRequestsPerMinute({})).toBe(DEFAULT_IP_REQUESTS_PER_MINUTE);
    expect(ipRequestsPerMinute({ IP_REQUESTS_PER_MINUTE: '250' })).toBe(250);
    expect(ipRequestsPerMinute({ IP_REQUESTS_PER_MINUTE: '0' })).toBe(0);
    for (const bad of ['-5', '2.5', 'lots']) expect(ipRequestsPerMinute({ IP_REQUESTS_PER_MINUTE: bad })).toBe(1000);
  });
});

describe('takeIpRequest', () => {
  it('allows the limit in a minute, then refuses without counting the refusals', () => {
    for (let i = 0; i < 5; i++) expect(takeIpRequest('a', 5, T0 + i).ok).toBe(true);
    const refused = takeIpRequest('a', 5, T0 + 10);
    expect(refused).toEqual({ ok: false, retryAfterSeconds: 60 });
    // Refusals aren't counted: well into the next minute the old five have
    // mostly slid out and the address gets through again.
    expect(takeIpRequest('a', 5, T0 + MIN + 50_000).ok).toBe(true);
  });

  it('counts each address on its own', () => {
    for (let i = 0; i < 3; i++) takeIpRequest('a', 3, T0);
    expect(takeIpRequest('a', 3, T0).ok).toBe(false);
    expect(takeIpRequest('b', 3, T0).ok).toBe(true);
  });

  it("carries last minute's share into this minute, so a burst at the boundary doesn't double the limit", () => {
    for (let i = 0; i < 10; i++) takeIpRequest('a', 10, T0 + MIN - 1);
    const allowedOf = (at: number, tries = 10) => {
      let n = 0;
      for (let i = 0; i < tries; i++) if (takeIpRequest('a', 10, at).ok) n++;
      return n;
    };
    // Just past the boundary the ten still count as a hair under ten: one more fits.
    expect(allowedOf(T0 + MIN + 1)).toBe(1);
    // Half way through, five of them count, plus that one: four more fit.
    expect(allowedOf(T0 + MIN + 30_000)).toBe(4);
  });

  it("forgets a minute that's long past", () => {
    for (let i = 0; i < 4; i++) takeIpRequest('a', 4, T0);
    expect(takeIpRequest('a', 4, T0 + 2 * MIN).ok).toBe(true);
  });

  it('with a full table drops the least recently seen address, and a request moves its address to the back', () => {
    // Limit 1: a tracked address that has made one request is refused; a
    // dropped one starts again from nothing and is let through.
    takeIpRequest('first', 1, T0);
    for (let i = 1; i < MAX_TRACKED; i++) takeIpRequest(`x${i}`, 1, T0);
    // The table is full. 'first' asks again: refused, and now the most recent.
    expect(takeIpRequest('first', 1, T0).ok).toBe(false);
    // A new address takes a slot from the least recently seen, x1, not 'first'.
    expect(takeIpRequest('newcomer', 1, T0).ok).toBe(true);
    expect(takeIpRequest('first', 1, T0).ok).toBe(false);
    expect(takeIpRequest('x2', 1, T0).ok).toBe(false);
    // x1 was dropped, so its count is gone: let through again (taking x3's slot).
    expect(takeIpRequest('x1', 1, T0).ok).toBe(true);
    expect(takeIpRequest('x3', 1, T0).ok).toBe(true);
  });

  it('says how long until the minute ends', () => {
    takeIpRequest('a', 1, T0 + 45_000);
    expect(takeIpRequest('a', 1, T0 + 45_000)).toEqual({ ok: false, retryAfterSeconds: 15 });
  });
});

function req(pathname: string, forwardedFor?: string) {
  const headers = new Headers({ 'x-forwarded-host': 'app.whiteroom.tech' });
  if (forwardedFor) headers.set('x-forwarded-for', forwardedFor);
  return new NextRequest(`https://internal.run.app${pathname}`, { headers });
}

describe('proxy: per-address limit', () => {
  it('answers 429 with Retry-After once an address passes the limit', () => {
    process.env.IP_REQUESTS_PER_MINUTE = '3';
    const from = '203.0.113.7, 198.51.100.1';
    for (let i = 0; i < 3; i++) expect(proxy(req('/sign-in', from))?.status).not.toBe(429);
    const res = proxy(req('/sign-in', from));
    expect(res?.status).toBe(429);
    expect(Number(res?.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(res?.headers.get('cache-control')).toBe('no-store');
    // Another address is unaffected.
    expect(proxy(req('/sign-in', '203.0.113.8, 198.51.100.1'))?.status).not.toBe(429);
  });

  it("can't be dodged by writing a different address in front, behind the load balancer or without one", () => {
    process.env.IP_REQUESTS_PER_MINUTE = '2';
    for (const [hops, tail] of [['1', '203.0.113.7, 198.51.100.1'], ['0', '203.0.113.9']] as const) {
      process.env.TRUSTED_PROXY_HOPS = hops;
      const statuses = [1, 2, 3, 4].map((n) => proxy(req('/sign-in', `10.0.0.${n}, ${tail}`))?.status);
      expect(statuses.slice(0, 2)).not.toContain(429);
      expect(statuses.slice(2)).toEqual([429, 429]);
    }
  });

  it('never limits Stripe webhooks or the internal scheduler routes', () => {
    process.env.IP_REQUESTS_PER_MINUTE = '1';
    const from = '54.187.174.169, 198.51.100.1';
    for (let i = 0; i < 5; i++) {
      expect(proxy(req('/api/stripe/webhook', from))?.status).not.toBe(429);
      expect(proxy(req('/api/internal/billing-sync', from))?.status).not.toBe(429);
    }
  });

  it('does nothing with the limit off or no address (local dev)', () => {
    process.env.IP_REQUESTS_PER_MINUTE = '0';
    for (let i = 0; i < 5; i++) expect(proxy(req('/sign-in', '203.0.113.7, 198.51.100.1'))?.status).not.toBe(429);
    process.env.IP_REQUESTS_PER_MINUTE = '1';
    for (let i = 0; i < 5; i++) expect(proxy(req('/sign-in'))?.status).not.toBe(429);
  });
});
