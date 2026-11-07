'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { signOut } from 'next-auth/react';
import { Button } from '@whiteroom/ui';
import { clearFleetCredentials } from '@/lib/fleet-credentials';
import { clearSandboxToken, forgetSandboxChoices } from '@/lib/sandbox/api';
import { clearSessionLocalState } from '@/lib/session-local-state';
import { broadcastAuthChange } from '@/hooks/useFleetAuth';
import { ThemedShell } from '@/components/ThemedShell';

const AFTER_SIGN_OUT = 'https://whiteroom.tech';

export default function SignOut() {
  const [failed, setFailed] = useState(false);
  const started = useRef(false);

  const run = useCallback(async () => {
    setFailed(false);
    clearFleetCredentials();
    // The sandbox token survives a fleet sign-out but not an account one: it
    // would otherwise authenticate the next account's sandbox calls.
    clearSandboxToken();
    forgetSandboxChoices();
    // Wait for the fleet cookie to be cleared before signing out: a request
    // still in flight when the page navigates can be cancelled, leaving a
    // 30-day fleet cookie behind for whoever signs in next on this browser.
    // The timeout keeps a slow server from holding sign-out hostage;
    // lib/fleet-session.ts also refuses a cookie minted for a different
    // account, so a clear that never lands is still contained.
    await fetch('/api/fleet/session', { method: 'DELETE', signal: AbortSignal.timeout(3000) }).catch(() => {});
    try {
      // Only once this resolves is the account session gone. Telling other
      // tabs before then would let them re-check, find the account still
      // signed in, and adopt its fleet into a fresh cookie.
      await signOut({ redirect: false });
    } catch {
      setFailed(true);
      return;
    }
    clearSessionLocalState();
    broadcastAuthChange();
    window.location.assign(AFTER_SIGN_OUT);
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run();
  }, [run]);

  return (
    <ThemedShell className="min-h-screen flex items-center justify-center">
      {failed ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <p role="alert" className="text-sm" style={{ color: 'var(--tx2)', margin: 0 }}>Couldn’t sign out. Try again.</p>
          <Button onClick={() => void run()}>Try again</Button>
        </div>
      ) : (
        <p className="text-sm font-mono" style={{ color: 'var(--tx2)' }}>Signing out...</p>
      )}
    </ThemedShell>
  );
}
