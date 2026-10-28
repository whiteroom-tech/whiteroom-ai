'use client';

import { useSyncExternalStore } from 'react';
import { savedViewerZone, subscribeViewerZone, viewerZone } from '@/lib/zone-time';

/**
 * The zone dates are shown in, re-rendering when Settings saves a new one.
 * null while server-rendering and hydrating (the server doesn't know the
 * viewer's zone), so nothing zone-dependent mismatches hydration.
 */
export function useViewerZone(): string | null {
  return useSyncExternalStore(subscribeViewerZone, viewerZone, () => null);
}

/** The zone saved on the account, or null (also while server-rendering) when dates follow the browser. */
export function useSavedViewerZone(): string | null {
  return useSyncExternalStore(subscribeViewerZone, savedViewerZone, () => null);
}
