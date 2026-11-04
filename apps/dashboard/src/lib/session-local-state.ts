// What this browser tab keeps from a fleet session that must not outlive it.
// Called on every confirmed sign-out, in whichever tab learns of it: the tab
// that signed out, and every other tab when its session check comes back 401.

import { clearSnapshots } from '@/lib/performance-snapshot';

export function clearSessionLocalState(): void {
  clearSnapshots(); // figures from this session don't outlive it
}
