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

import { createContext, createElement, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { clearFleetCredentials, getFleetCredentials } from '@/lib/fleet-credentials';
import { claimFleet, isAuthError, listFleets } from '@/lib/whiteroom/client';
import { isApiKey, loginFleet, resolveAuthKey } from '@/lib/fleet-helpers';
import { safeSet } from '@/lib/safe-storage';
import { clearSnapshots } from '@/lib/performance-snapshot';
import { clearSessionLocalState } from '@/lib/session-local-state';

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
  /**
   * A call was refused as unauthorised. Hides the page at once, then lets the
   * server decide: signs out only when the session really is gone, reloads
   * when another tab has switched this browser to a different fleet, and
   * otherwise keeps the session and offers Try again.
   */
  resetSession: (loginError?: string) => void;
  /**
   * Where a session-less visitor belongs instead of the key form: 'sign_in'
   * when there is no account session, 'setup' when the account has no fleet
   * yet (or its fleet session was rejected) — Fleet key provisions it.
   */
  needs: FleetAuthNeeds;
}

export type FleetAuthNeeds = 'sign_in' | 'setup' | null;

const SESSION_URL = '/api/fleet/session';
/** After an auth error: is the session really gone? (Clears it only if so.) */
const RECHECK_URL = '/api/fleet/session/recheck';
const RETRYABLE_MESSAGE =
  'Could not reach the WhiteRoom server. Your session was kept — retry when you are back online.';

/** Nudges other tabs to re-check the cookie session (storage events only fire cross-tab). */
export function broadcastAuthChange(): void {
  safeSet('wr_auth_ping', String(Date.now()));
}

/** Said when the session is fine but a page's call was still refused. */
const REFUSED_MESSAGE = 'This page couldn’t load. You’re still signed in, so try again.';

/** What the recheck answers (app/api/fleet/session/recheck). */
type ResetVerdict = { cleared: true; signedIn?: boolean } | { cleared: false; fleetId: string };

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

const FleetAuthContext = createContext<FleetAuthState | null>(null);

/**
 * One fleet session for every page under it ((citadel)/layout): the session
 * is checked once per page load instead of on every page, so moving between
 * pages doesn't wait on /api/fleet/session again.
 */
export function FleetAuthProvider({ children }: { children: React.ReactNode }) {
  return createElement(FleetAuthContext.Provider, { value: useOwnFleetAuth(true) }, children);
}

/** The shared session inside FleetAuthProvider; elsewhere this component's own. */
export function useFleetAuth(): FleetAuthState {
  const shared = useContext(FleetAuthContext);
  const own = useOwnFleetAuth(shared === null);
  return shared ?? own;
}

/** The session check itself. Idle (no requests, no listeners) when `active` is false. */
function useOwnFleetAuth(active: boolean): FleetAuthState {
  const [status, setStatus] = useState<FleetAuthStatus>('checking');
  const [fleetId, setFleetId] = useState<string | null>(null);
  // Always null for cookie-based sessions; kept in state (and in the public
  // shape) so existing consumers compile and legacy flows type-check.
  const [fleetToken, setFleetToken] = useState<string | null>(null);
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [retryableError, setRetryableError] = useState<string | null>(null);
  const [needs, setNeeds] = useState<FleetAuthNeeds>(null);
  // Bumped to re-run the bootstrap effect (retry, cross-tab pings).
  const [attempt, setAttempt] = useState(0);
  // The fleet this tab is showing, for telling a sign-out from an account switch.
  const shownFleet = useRef<string | null>(null);
  useEffect(() => { shownFleet.current = fleetId; }, [fleetId]);
  // One verdict at a time: a page can hit several auth errors in one poll.
  const resetting = useRef(false);
  // A session check (a ping, Try again) that came while a verdict was pending: it
  // waits, so it can't show the page again before the verdict says whether to.
  const checkWaiting = useRef(false);

  /** This browser now holds a different fleet's session: start the tab fresh. */
  const switchedFleet = useCallback(() => {
    setStatus('checking'); // pages unmount their content now
    clearSnapshots();
    window.location.reload();
  }, []);

  /** A confirmed sign-out: nothing of the session stays in this tab. */
  const signedOut = useCallback((next: FleetAuthNeeds, message?: string) => {
    clearSessionLocalState();
    setFleetId(null);
    setFleetToken(null);
    setRetryableError(null);
    setNeeds(next);
    setStatus('unauthenticated');
    if (message) setLoginError(message);
  }, []);

  const resetSession = useCallback((message?: string) => {
    if (resetting.current) return;
    // Hide the page before anything else: whatever it shows may belong to a
    // session that's gone.
    setStatus('checking');
    const expectFleetId = shownFleet.current;
    if (!expectFleetId) {
      // No fleet to check against: sign out as before.
      clearFleetCredentials();
      fetch(SESSION_URL, { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
      signedOut('setup', message);
      broadcastAuthChange();
      return;
    }
    resetting.current = true;
    (async () => {
      let verdict: ResetVerdict | null = null;
      try {
        const res = await fetch(RECHECK_URL, { method: 'POST', credentials: 'same-origin', cache: 'no-store' });
        if (res.ok) verdict = (await res.json()) as ResetVerdict;
      } catch {
        /* network: no verdict */
      }
      if (!verdict) {
        // The server couldn't say. Nothing was cleared: keep the session.
        setRetryableError(RETRYABLE_MESSAGE);
        setStatus('unauthenticated');
      } else if (verdict.cleared) {
        clearFleetCredentials();
        // The engine rejected the session: Fleet key re-provisions and re-links it.
        // With no session at all, the account's own state decides.
        signedOut('signedIn' in verdict && verdict.signedIn === false ? 'sign_in' : 'setup', message);
        broadcastAuthChange();
      } else if (verdict.fleetId !== expectFleetId) {
        checkWaiting.current = false; // the reload checks afresh
        switchedFleet();
      } else {
        // Same fleet, session fine: the refusal was about something else.
        // Not straight back in, or the page would hit the same refusal again.
        setRetryableError(REFUSED_MESSAGE);
        setStatus('unauthenticated');
      }
    })().finally(() => {
      resetting.current = false;
      // A check that waited runs now, against the session as the verdict left it.
      if (checkWaiting.current) { checkWaiting.current = false; setAttempt((a) => a + 1); }
    });
  }, [signedOut, switchedFleet]);

  // Bootstrap: migrate legacy localStorage creds into the cookie, else ask
  // the server whether a cookie/next-auth session already exists.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    async function bootstrap() {
      if (resetting.current) { checkWaiting.current = true; return; }
      const legacy = getFleetCredentials();

      if (legacy.fleetToken) {
        // One-time migration of a pre-cookie session.
        const result = await createSession(legacy.fleetToken);
        if (cancelled) return;
        if (result.outcome === 'ok') {
          clearFleetCredentials(); // token leaves the browser for good
          const next = result.fleetId || legacy.fleetId;
          if (shownFleet.current && next && next !== shownFleet.current) { switchedFleet(); return; }
          setFleetId(next);
          setFleetToken(null);
          setRetryableError(null);
          setNeeds(null);
          setStatus('authenticated');
        } else if (result.outcome === 'rejected') {
          clearFleetCredentials();
          setFleetId(null);
          setFleetToken(null);
          setStatus('unauthenticated');
          setLoginError('Fleet token invalid. Please enter your WhiteRoom fleet key.');
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
          // Another tab signed in as a different fleet: this one starts fresh.
          if (shownFleet.current && data.fleetId && data.fleetId !== shownFleet.current) { switchedFleet(); return; }
          setFleetId(data.fleetId ?? null);
          setFleetToken(null);
          setRetryableError(null);
          setNeeds(null);
          setStatus('authenticated');
        } else if (res.status === 401) {
          const body = (await res.json().catch(() => ({}))) as { signedIn?: boolean };
          if (cancelled) return;
          // Also how a tab hears that another tab signed out (ping, re-check, 401).
          signedOut(body.signedIn ? 'setup' : 'sign_in');
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
  }, [attempt, active, signedOut, switchedFleet]);

  // Keep tabs in sync. Legacy wr_* keys still trigger a re-check (a
  // pre-deploy tab may write them); `wr_auth_ping` is the nudge this hook
  // writes after cookie sign-in/sign-out, since httpOnly cookies fire no
  // storage events of their own.
  useEffect(() => {
    if (!active) return;
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
  }, [active]);

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
        const fleet = loginFleet(listData.fleets ?? []);
        if ('error' in fleet) {
          setLoginError(fleet.error);
          return;
        }
        const claim = await claimFleet(fleet.fleetId, token);
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
      setNeeds(null);
      setStatus('authenticated');
      broadcastAuthChange();
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
    needs,
  };
}
