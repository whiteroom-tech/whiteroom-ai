'use client';

import { SessionProvider } from 'next-auth/react';
import type { Session } from 'next-auth';
import { setViewerZone } from '@/lib/zone-time';

export function Providers({ children, session, timeZone = null }: { children: React.ReactNode; session: Session | null; timeZone?: string | null }) {
  // The account's saved zone, set before any page below renders so every day
  // and time is in it from the first paint. Browser only: on the server the
  // module is shared by every request, so it must never hold one person's zone.
  if (typeof window !== 'undefined') setViewerZone(timeZone);
  return <SessionProvider session={session}>{children}</SessionProvider>;
}
