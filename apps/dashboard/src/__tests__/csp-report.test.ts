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
  it('reads the Reporting API format, logs at most five, and strips control characters', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const one = { body: { effectiveDirective: 'script-src-elem', blockedURL: 'inline', documentURL: 'https://app.test/runs\n[csp] forged' } };
    expect((await post(JSON.stringify(Array(7).fill(one)))).status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(5);
    expect(warn.mock.calls[0][0]).toBe('[csp] script-src-elem blocked inline on https://app.test/runs [csp] forged');
  });
});
