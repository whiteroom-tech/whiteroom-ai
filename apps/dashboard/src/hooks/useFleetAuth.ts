'use client';

// Canonical fleet auth flow for the Citadel pages.
//
// The fleet token now lives in server-side custody: an httpOnly cookie
// (`wr_fleet_auth`) minted by POST /api/fleet/session. Page script never
// sees or stores the token any more — keyless client calls ride through the
// /api/fleet/engine BFF, which attaches the cookie's token server-side.
// That kills the XSS-exfiltratable long-lived credential that used to sit
// in localStorage, while keeping both auth models working:
//   (a) raw fleet-token / API-key login with no next-auth session, and
//   (b) next-auth session users, whose linked user_fleets token the session
//       route adopts into the cookie automatically.
//
// Consequences for consumers (public API shape is unchanged):
// - `fleetToken` is null and `authKey` undefined for cookie-based sessions;
//   keyless calls through @/lib/whiteroom/client work regardless.
// - Legacy localStorage credentials (`wr_fleet_token` / `wr_token`) are
//   migrated into the cookie once on load, then cleared.
// - Only a real 401 (credential rejection) signs the user out. A network
//   blip / 5xx keeps the session and exposes retryableError + retry().

import { useCallback, useEffect, useState } from 'react';
import { clearFleetCredentials, getFleetCredentials } from '@/lib/fleet-credentials';
import { claimFleet, isAuthError, listFleets } from '@/lib/whiteroom/client';
import { isApiKey, preferProductionFleet, resolveAuthKey } from '@/lib/fleet-helpers';
import { safeSet } from '@/lib/safe-storage';

export type FleetAuthStatus = 'checking' | 'authenticated' | 'unauthenticated';

export interface FleetAuthState {
  status: FleetAuthStatus;
  fleetId: string | null;
  fleetToken: string | null;
  /** Pass to API calls (resolveAuthKey of the fleet token). */
  authKey: string | undefined;
  /** Error to show on the login form (bad token, no fleets, ...). */
  loginError: string;
  loginLoading: boolean;
  /**
   * Set when the stored session could not be verified for a NON-auth reason
   * (network/timeout/5xx). Credentials are kept; offer retry() instead of a
   * fresh login.
   */
  retryableError: string | null;
  /** Log in with an API key (sk-...) or a fleet token. */
  login: (token: string) => Promise<void>;
  /** Re-run the stored-session check after a retryable failure. */
  retry: () => void;
  /** Sign out: clears credentials and returns to the login form. */
  resetSession: (loginError?: string) => void;
}

const SESSION_URL = '/api/fleet/session';
const RETRYABLE_MESSAGE =
  'Could not reach the WhiteRoom server. Your session was kept — retry when you are back online.';

/** Nudges other tabs to re-check the cookie session (storage events only fire cross-tab). */
function pingOtherTabs(): void {
  safeSet('wr_auth_ping', String(Date.now()));
}

/**
 * POST the token to the session route, which validates it against the engine
 * and moves it into the httpOnly cookie. Distinguishes a credential rejection
 * (401) from "engine/route unreachable" so callers keep legacy creds on the
 * latter.
 */
async function createSession(
  token: string,
): Promise<{ outcome: 'ok'; fleetId: string } | { outcome: 'rejected' } | { outcome: 'unreachable' }> {
  try {
    const res = await fetch(SESSION_URL, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (res.ok) {
      const data = (await res.json()) as { fleetId?: string };
      return { outcome: 'ok', fleetId: data.fleetId ?? '' };
    }
    if (res.status === 401) return { outcome: 'rejected' };
    // 400/403/502/5xx: not a credential verdict.
    return { outcome: 'unreachable' };
  } catch {
    return { outcome: 'unreachable' };
  }
}

export function useFleetAuth(): FleetAuthState {
  const [status, setStatus] = useState<FleetAuthStatus>('checking');
  const [fleetId, setFleetId] = useState<string | null>(null);
  // Always null for cookie-based sessions; kept in state (and in the public
  // shape) so existing consumers compile and legacy flows type-check.
  const [fleetToken, setFleetToken] = useState<string | null>(null);
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [retryableError, setRetryableError] = useState<string | null>(null);
  // Bumped to re-run the bootstrap effect (retry, cross-tab pings).
  const [attempt, setAttempt] = useState(0);

  const resetSession = useCallback((message?: string) => {
    // Clear legacy localStorage leftovers AND the server-side cookie. The
    // DELETE is fire-and-forget: the UI signs out immediately either way,
    // and the cookie clear is idempotent.
    clearFleetCredentials();
    fetch(SESSION_URL, { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
    setFleetId(null);
    setFleetToken(null);
    setRetryableError(null);
    setStatus('unauthenticated');
    if (message) setLoginError(message);
    pingOtherTabs();
  }, []);

  // Bootstrap: migrate legacy localStorage creds into the cookie, else ask
  // the server whether a cookie/next-auth session already exists.
  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      const legacy = getFleetCredentials();

      if (legacy.fleetToken) {
        // One-time migration of a pre-cookie session.
        const result = await createSession(legacy.fleetToken);
        if (cancelled) return;
        if (result.outcome === 'ok') {
          clearFleetCredentials(); // token leaves the browser for good
          setFleetId(result.fleetId || legacy.fleetId);
          setFleetToken(null);
          setRetryableError(null);
          setStatus('authenticated');
        } else if (result.outcome === 'rejected') {
          clearFleetCredentials();
          setFleetId(null);
          setFleetToken(null);
          setStatus('unauthenticated');
          setLoginError('Fleet token invalid. Please enter your API key.');
        } else {
          // Engine/route unreachable: the token may be perfectly fine.
          // Keep the legacy creds and let the user retry the migration.
          setRetryableError(RETRYABLE_MESSAGE);
          setStatus('unauthenticated');
        }
        return;
      }

      // No legacy creds: does the server already hold a session for us?
      try {
        const res = await fetch(SESSION_URL, {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (cancelled) return;
        if (res.ok) {
          const data = (await res.json()) as { fleetId?: string };
          setFleetId(data.fleetId ?? null);
          setFleetToken(null);
          setRetryableError(null);
          setStatus('authenticated');
        } else if (res.status === 401) {
          setFleetId(null);
          setFleetToken(null);
          setStatus('unauthenticated');
        } else {
          setRetryableError(RETRYABLE_MESSAGE);
          setStatus('unauthenticated');
        }
      } catch {
        if (cancelled) return;
        setRetryableError(RETRYABLE_MESSAGE);
        setStatus('unauthenticated');
      }
    }

    bootstrap();
    return () => { cancelled = true; };
  }, [attempt]);

  // Keep tabs in sync. Legacy wr_* keys still trigger a re-check (a
  // pre-deploy tab may write them); `wr_auth_ping` is the nudge this hook
  // writes after cookie sign-in/sign-out, since httpOnly cookies fire no
  // storage events of their own.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (
        e.key !== null &&
        e.key !== 'wr_fleet' &&
        e.key !== 'wr_fleet_token' &&
        e.key !== 'wr_token' &&
        e.key !== 'wr_auth_ping'
      ) return;
      setAttempt((a) => a + 1);
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const login = useCallback(async (token: string) => {
    setLoginError('');
    setRetryableError(null);
    setLoginLoading(true);
    try {
      let fleetTokenToStore = token;

      if (isApiKey(token)) {
        // API key: resolve the preferred fleet and claim its token first
        // (both calls carry the typed key explicitly, so they go direct to
        // the engine — no cookie involved yet).
        const listData = await listFleets(token);
        const fleets = preferProductionFleet(listData.fleets ?? []);
        if (!fleets.length) {
          setLoginError('No fleets found for this API key. Register an agent first.');
          return;
        }
        const claim = await claimFleet(fleets[0].fleetId, token);
        if (claim.error || !claim.fleetToken) {
          setLoginError(claim.error || 'Could not retrieve fleet token.');
          return;
        }
        fleetTokenToStore = claim.fleetToken;
      }

      // Hand the token to the server; nothing is persisted client-side.
      const result = await createSession(fleetTokenToStore);
      if (result.outcome === 'rejected') {
        setLoginError('That key or token was rejected. Check it and try again.');
        return;
      }
      if (result.outcome === 'unreachable') {
        setLoginError('Could not connect to WhiteRoom server');
        return;
      }

      setFleetId(result.fleetId);
      setFleetToken(null);
      setStatus('authenticated');
      pingOtherTabs();
    } catch (e) {
      setLoginError(isAuthError(e)
        ? 'That key or token was rejected. Check it and try again.'
        : 'Could not connect to WhiteRoom server');
    } finally {
      setLoginLoading(false);
    }
  }, []);

  const retry = useCallback(() => {
    setRetryableError(null);
    setStatus('checking');
    setAttempt((a) => a + 1);
  }, []);

  return {
    status,
    fleetId,
    fleetToken,
    authKey: resolveAuthKey(fleetToken),
    loginError,
    loginLoading,
    retryableError,
    login,
    retry,
    resetSession,
  };
}
