import { describe, expect, it, vi } from 'vitest';
vi.mock('posthog-js', () => ({ default: {} }));
import { scrubAnalyticsProperties } from '@/lib/analytics';

describe('analytics credential redaction', () => {
  it('removes URL query strings and fragments, including nested initial referrers', () => {
    const result = scrubAnalyticsProperties({
      $current_url: 'https://app.example.com/settings?token=secret#credential',
      $set: { $initial_referrer: 'https://app.example.com/auth/verify?token=secret&email=private' },
      fleet_token: 'secret',
      event_name: 'signed_in',
    });
    expect(result).toEqual({
      $current_url: 'https://app.example.com/settings',
      $set: { $initial_referrer: 'https://app.example.com/auth/verify' },
      event_name: 'signed_in',
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});
