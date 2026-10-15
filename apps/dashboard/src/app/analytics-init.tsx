'use client';

import { useEffect } from 'react';
import { useSession } from 'next-auth/react';
import { initAnalytics } from '@/lib/analytics';

/** Analytics starts once there's a signed-in user to attribute events to. */
export function AnalyticsInit() {
  const userId = useSession().data?.user?.id;
  useEffect(() => {
    if (userId) initAnalytics(userId);
  }, [userId]);
  return null;
}
