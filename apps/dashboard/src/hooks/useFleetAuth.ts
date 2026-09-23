'use client';

// Canonical fleet auth flow, extracted from the ~150-line block that was
// copy-pasted (and drifting) across the agents, runs, and performance pages.
//
// Fixes over the copies it replaces:
// - Three-state status: 'checking' → 'authenticated' | 'unauthenticated', so
//   the login form no longer flashes on every load (the copies initialized
//   authenticated=false and only flipped it in an effect).
// - Only a real 401/403 (isAuthError) clears credentials. A network blip,
//   timeout, or 5xx keeps them and exposes retryableError + retry() instead
//   of dumping the user back to the login form with wiped storage.
// - No window.location.reload() after login — state updates instead.
// - Listens for the `storage` event so sign-in/sign-out in one tab is
//   reflected in the others.

import { useCallback, useEffect, useState } from 'react';
import {
  clearFleetCredentials,
  getFleetCredentials,
  setFleetCredentials,
} from '@/lib/fleet-credentials';
import { claimFleet, isAuthError, listFleets, tokenLogin } from '@/lib/whiteroom/client';
import { isApiKey, preferProductionFleet, resolveAuthKey } from '@/lib/fleet-helpers';

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

export function useFleetAuth(): FleetAuthState {
  const [status, setStatus] = useState<FleetAuthStatus>('checking');
  const [fleetId, setFleetId] = useState<string | null>(null);
  const [fleetToken, setFleetToken] = useState<string | null>(null);
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [retryableError, setRetryableError] = useState<string | null>(null);
  // Bumped to re-run the bootstrap effect (retry, cross-tab storage changes).
  const [attempt, setAttempt] = useState(0);

  const resetSession = useCallback((message?: string) => {
    clearFleetCredentials();
    setFleetId(null);
    setFleetToken(null);
    setRetryableError(null);
    setStatus('unauthenticated');
    if (message) setLoginError(message);
  }, []);

  // Bootstrap from storage.
  useEffect(() => {
    let cancelled = false;
    const creds = getFleetCredentials();

    if (!creds.fleetToken) {
      setFleetId(null);
      setFleetToken(null);
      setStatus('unauthenticated');
      return;
    }

    if (creds.fleetId) {
      setFleetId(creds.fleetId);
      setFleetToken(creds.fleetToken);
      setRetryableError(null);
      setStatus('authenticated');
      return;
    }

    // Token without a fleet id (older sessions; the onboarding bug that wrote
    // only the token): resolve the fleet id from the token.
    const token = creds.fleetToken;
    setStatus('checking');
    tokenLogin(token)
      .then((data) => {
        if (cancelled) return;
        if (data.fleetId) {
          setFleetCredentials(data.fleetId, token);
          setFleetId(data.fleetId);
          setFleetToken(token);
          setRetryableError(null);
          setStatus('authenticated');
        } else {
          resetSession('Fleet token invalid. Please enter your API key.');
        }
      })
      .catch((e) => {
        if (cancelled) return;
        if (isAuthError(e)) {
          resetSession('Fleet token invalid. Please enter your API key.');
        } else {
          // Network/timeout/5xx: the token may be perfectly fine. Keep it.
          setRetryableError('Could not reach the WhiteRoom server. Your session was kept — retry when you are back online.');
          setStatus('unauthenticated');
        }
      });
    return () => { cancelled = true; };
  }, [attempt, resetSession]);

  // Keep tabs in sync: another tab signing in or out changes the wr_* keys.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== null && e.key !== 'wr_fleet' && e.key !== 'wr_fleet_token' && e.key !== 'wr_token') return;
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
      let resolvedFleetId: string;
      let resolvedFleetToken: string;

      if (isApiKey(token)) {
        const listData = await listFleets(token);
        const fleets = preferProductionFleet(listData.fleets ?? []);
        if (!fleets.length) {
          setLoginError('No fleets found for this API key. Register an agent first.');
          return;
        }
        resolvedFleetId = fleets[0].fleetId;
        const claim = await claimFleet(resolvedFleetId, token);
        if (claim.error || !claim.fleetToken) {
          setLoginError(claim.error || 'Could not retrieve fleet token.');
          return;
        }
        resolvedFleetToken = claim.fleetToken;
      } else {
        const data = await tokenLogin(token);
        if (data.error) {
          setLoginError(data.error);
          return;
        }
        resolvedFleetId = data.fleetId ?? '';
        resolvedFleetToken = token;
      }

      setFleetCredentials(resolvedFleetId, resolvedFleetToken);
      setFleetId(resolvedFleetId);
      setFleetToken(resolvedFleetToken);
      setStatus('authenticated');
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
