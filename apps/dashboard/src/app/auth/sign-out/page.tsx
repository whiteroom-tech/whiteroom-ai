'use client';

import { useEffect } from 'react';
import { signOut } from 'next-auth/react';
import { clearFleetCredentials } from '@/lib/fleet-credentials';

export default function SignOut() {
  useEffect(() => {
    clearFleetCredentials();
    void fetch('/api/fleet/session', { method: 'DELETE' }).catch(() => {});
    signOut({ callbackUrl: 'https://whiteroom.tech' });
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: '#070B14' }}>
      <p className="text-sm font-mono" style={{ color: '#6B7C9E' }}>Signing out...</p>
    </div>
  );
}
