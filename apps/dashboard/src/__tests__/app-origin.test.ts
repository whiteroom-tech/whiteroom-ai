import { afterEach, describe, expect, it, vi } from 'vitest';
import { appOrigin } from '@/lib/app-origin';

afterEach(() => vi.unstubAllEnvs());
describe('trusted application origin', () => {
  it('uses the canonical fallback without request headers', () => {
    vi.stubEnv('AUTH_URL', '');
    expect(appOrigin()).toBe('https://app.whiteroom.tech');
  });
  it('normalizes configured URLs to an origin', () => {
    vi.stubEnv('AUTH_URL', 'https://dashboard.example.com/api/auth?unused=1');
    expect(appOrigin()).toBe('https://dashboard.example.com');
  });
  it.each(['http://example.com', 'https://user:pass@example.com', 'javascript:alert(1)'])('rejects unsafe configuration %s', (value) => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AUTH_URL', value);
    expect(appOrigin).toThrow();
  });
  it('allows explicit local development', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('AUTH_URL', 'http://localhost:3000');
    expect(appOrigin()).toBe('http://localhost:3000');
  });
});
