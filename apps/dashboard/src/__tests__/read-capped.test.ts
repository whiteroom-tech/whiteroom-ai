import { describe, expect, it } from 'vitest';
import { readCapped } from '@/lib/read-capped';

const req = (body?: BodyInit, headers?: Record<string, string>) => new Request('http://localhost/x', { method: 'POST', body, headers, duplex: 'half' } as RequestInit);

describe('readCapped', () => {
  it('returns a body up to the limit, and an empty one when there is none', async () => {
    expect(new TextDecoder().decode((await readCapped(req('hello'), 5))!)).toBe('hello');
    expect((await readCapped(req(), 5))!.byteLength).toBe(0);
  });

  it('refuses a body one byte over, by its declared length or by what arrives', async () => {
    expect(await readCapped(req('hello!'), 5)).toBeNull();
    // Counted in bytes, not characters.
    expect(await readCapped(req('héllo'), 5)).toBeNull();
    const chunks = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(3)); c.enqueue(new Uint8Array(3)); c.close(); } });
    expect(await readCapped(req(chunks), 5)).toBeNull();
  });

  it('a declared length that understates the body does not get it past the limit', async () => {
    const big = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(64)); c.close(); } });
    expect(await readCapped(req(big, { 'content-length': '2' }), 5)).toBeNull();
  });

  it('a body that breaks off mid-send is refused, not thrown', async () => {
    const broken = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(2)); }, pull(c) { c.error(new Error('client went away')); } });
    expect(await readCapped(req(broken), 64)).toBeNull();
  });
});
