'use client';

import { useEffect } from 'react';
import { signOut } from 'next-auth/react';
import { clearFleetCredentials } from '@/lib/fleet-credentials';

export default function SignOut() {
  useEffect(() => {
    clearFleetCredentials();
    // Wait for the fleet cookie to be cleared before signing out. signOut()
    // navigates away, and a request still in flight at that point can be
    // cancelled — leaving a 30-day fleet cookie behind for whoever signs in
    // next on this browser. The timeout keeps a slow or unreachable server
    // from holding sign-out hostage; lib/fleet-session.ts also refuses a
    // cookie minted for a different account, so a clear that never lands is
    // still contained.
    fetch('/api/fleet/session', { method: 'DELETE', signal: AbortSignal.timeout(3000) })
      .catch(() => {})
      .finally(() => signOut({ callbackUrl: 'https://whiteroom.tech' }));
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: '#070B14' }}>
      <p className="text-sm font-mono" style={{ color: '#6B7C9E' }}>Signing out...</p>
    </div>
  );
}
