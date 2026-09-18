'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import * as api from './api';
import type { RunStatusResult, HistoryEntry } from './api';

export interface UseRunResult {
  status: RunStatusResult | null;
  setStatus: (s: RunStatusResult | null) => void;
  history: HistoryEntry[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  startPolling: (sandboxId?: string) => void;
  stopPolling: () => void;
}

export function useRun(): UseRunResult {
  const [status, setStatus] = useState<RunStatusResult | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failureCount = useRef(0);
  const mountedRef = useRef(true);

  const fetchStatus = useCallback(async () => {
    try {
      const data = await api.getStatus();
      if (!mountedRef.current) return;
      setStatus(data);
      setError(null);
      failureCount.current = 0;
      setLoading(false);
    } catch {
      if (!mountedRef.current) return;
      failureCount.current++;
      if (failureCount.current >= 2) {
        setError('Connection interrupted');
      }
      setLoading(false);
    }
  }, []);

  const scheduleNext = useCallback(() => {
    const delay = failureCount.current > 0
      ? Math.min(30000, 3000 * Math.pow(2, failureCount.current))
      : 3000;
    pollRef.current = setTimeout(async () => {
      await fetchStatus();
      if (mountedRef.current) {
        scheduleNext();
      }
    }, delay);
  }, [fetchStatus]);

  const startPolling = useCallback((_sandboxId?: string) => {
    if (pollRef.current) clearTimeout(pollRef.current);
    failureCount.current = 0;
    scheduleNext();
  }, [scheduleNext]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    async function init() {
      await fetchStatus();
      const h = await api.getHistory();
      if (mountedRef.current && h.sessions) {
        setHistory(h.sessions);
      }
    }
    init();
    return () => {
      mountedRef.current = false;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [fetchStatus]);

  return { status, setStatus, history, loading, error, refresh: fetchStatus, startPolling, stopPolling };
}
