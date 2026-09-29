'use client';

/**
 * One Diagnosis read shared by the attention strip, the card header and What
 * we checked (spec Rev 4.4 §6.7). One call on load; on window focus at most
 * every 5 minutes and never while the tab is hidden; never runs a check on
 * load. If the engine has Diagnosis switched off, `data` stays null and
 * nothing renders.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { diagnoseFleet, getDiagnosis } from '@/lib/whiteroom/client';
import type { FleetDiagnosis } from '@/lib/whiteroom/types';
import { shouldRefetchOnFocus, type RunState } from './model';

export function useDiagnosis(fleetId: string, authKey?: string) {
  const [data, setData] = useState<FleetDiagnosis | null>(null);
  const [run, setRun] = useState<RunState>('idle');
  const [justRan, setJustRan] = useState(false);
  const lastFetched = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const d = await getDiagnosis(fleetId, authKey);
      lastFetched.current = Date.now();
      setData(d);
    } catch {
      // Off on this engine, or unreachable: keep what's shown.
    }
  }, [fleetId, authKey]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const onFocus = () => {
      if (shouldRefetchOnFocus(lastFetched.current, Date.now(), document.visibilityState === 'hidden')) void refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const checkNow = useCallback(async (): Promise<boolean> => {
    setRun('checking');
    try {
      const d = await diagnoseFleet(fleetId, { force: true }, authKey);
      lastFetched.current = Date.now();
      setData(d);
      setJustRan(true);
      setRun('idle');
      return true;
    } catch {
      setRun('error');
      return false;
    }
  }, [fleetId, authKey]);

  return { data, run, justRan, refresh, checkNow };
}
