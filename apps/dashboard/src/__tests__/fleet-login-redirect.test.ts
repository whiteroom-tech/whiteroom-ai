import { describe, expect, it } from 'vitest';
import { redirectFor } from '@/components/citadel/FleetLogin';

describe('FleetLogin redirect instead of the key form', () => {
  it('sends a visitor without an account session to sign-in, and back after', () => {
    expect(redirectFor('sign_in', '/runs?range=7d')).toBe('/sign-in?callbackUrl=%2Fruns%3Frange%3D7d');
  });

  it('sends a signed-in account without a fleet session to Fleet key', () => {
    expect(redirectFor('setup', '/home')).toBe('/fleet-key');
  });

  it('keeps the form only when there is nowhere better to go', () => {
    expect(redirectFor(null, '/home')).toBeNull();
  });
});
