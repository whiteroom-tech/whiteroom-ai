// The Sandbox's single "paste your key" field decides from the prefix whether
// it was given a provider key (hashed to create the test) or a WhiteRoom fleet
// token (sent as the token). Getting this wrong would send a secret down the
// wrong path, so each prefix is pinned here.

import { describe, it, expect, vi } from 'vitest';

vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null, status: 'unauthenticated' }) }));
vi.mock('@/lib/analytics', () => ({ posthog: { capture: () => {} } }));

const { detectKey } = await import('@/components/sandbox/TestRunFlow');

describe('detectKey', () => {
  it('recognizes provider keys', () => {
    expect(detectKey('sk-ant-api03-abc')).toBe('anthropic');
    expect(detectKey('sk-proj-abc')).toBe('openai');
    expect(detectKey('sk-abc')).toBe('openai');
  });

  it('recognizes a fleet token', () => {
    expect(detectKey('wr_dc775c70-bf5e-4d5b-89f8-f6946b7b39e6')).toBe('fleet');
  });

  it('does not treat a WhiteRoom account key as a provider key', () => {
    expect(detectKey('sk-wr-0123abcd')).toBe('account');
  });

  it('ignores surrounding spaces and rejects anything else', () => {
    expect(detectKey('  sk-ant-x  ')).toBe('anthropic');
    expect(detectKey('')).toBe('empty');
    expect(detectKey('   ')).toBe('empty');
    expect(detectKey('AIzaSy-google')).toBe('unknown');
  });
});
