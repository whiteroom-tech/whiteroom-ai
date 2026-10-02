import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/csp-report/route';

afterEach(() => { vi.restoreAllMocks(); });
const post = (body: string) => POST(new Request('https://app.test/api/csp-report', { method: 'POST', body }));

describe('CSP report endpoint', () => {
  it('logs the directive and blocked source without query strings', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await post(JSON.stringify({ 'csp-report': { 'violated-directive': 'script-src', 'blocked-uri': 'https://evil.test/x.js?t=secret', 'document-uri': 'https://app.test/home?token=abc' } }));
    expect(res.status).toBe(204);
    expect(warn).toHaveBeenCalledWith('[csp] script-src blocked https://evil.test/x.js on https://app.test/home');
  });
  it('refuses oversized bodies and ignores junk', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await post('x'.repeat(9000))).status).toBe(413);
    expect((await post('not json')).status).toBe(204);
  });
});
