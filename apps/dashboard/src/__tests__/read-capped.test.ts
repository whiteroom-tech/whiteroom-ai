import { describe, expect, it } from 'vitest';
import { readCapped } from '@/lib/read-capped';

const req = (body?: BodyInit, headers?: Record<string, string>) => new Request('http://localhost/x', { method: 'POST', body, headers, duplex: 'half' } as RequestInit);

describe('readCapped', () => {
  it('returns a body up to the limit, and an empty one when there is none', async () => {
    expect(new TextDecoder().decode((await readCapped(req('hello'), 5)) as Uint8Array)).toBe('hello');
    expect(((await readCapped(req(), 5)) as Uint8Array).byteLength).toBe(0);
  });

  it('refuses a body one byte over, by its declared length or by what arrives', async () => {
    expect(await readCapped(req('hello!'), 5)).toBe('too_large');
    // Counted in bytes, not characters.
    expect(await readCapped(req('héllo'), 5)).toBe('too_large');
    const chunks = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(3)); c.enqueue(new Uint8Array(3)); c.close(); } });
    expect(await readCapped(req(chunks), 5)).toBe('too_large');
  });

  it('a declared length that understates the body does not get it past the limit', async () => {
    const big = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(64)); c.close(); } });
    expect(await readCapped(req(big, { 'content-length': '2' }), 5)).toBe('too_large');
  });

  it('a body that breaks off mid-send is unreadable, not too large, and not thrown', async () => {
    const broken = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(2)); }, pull(c) { c.error(new Error('client went away')); } });
    expect(await readCapped(req(broken), 64)).toBe('unreadable');
  });

  it('a body over the limit is too large even when cancelling the rest fails', async () => {
    const big = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(64)); }, cancel() { throw new Error('already gone'); } });
    expect(await readCapped(req(big), 5)).toBe('too_large');
  });
});
