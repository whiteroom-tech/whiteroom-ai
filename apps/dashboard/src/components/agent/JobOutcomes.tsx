'use client';

import { useEffect, useState } from 'react';
import { jobOutcomes } from '@/lib/whiteroom/client';

/**
 * Agent detail › Jobs (Agent Health item 3): "Jobs: 42 of 50 succeeded (84%)
 * · last 7 days · reported by your system". Only when the customer's system
 * reported outcomes for this agent; hidden otherwise, and on engines
 * without them. WhiteRoom verifies nothing: it shows what was reported.
 */
export function JobOutcomes({ fleetId, agentId, authKey, preview }: { fleetId: string; agentId: string; authKey?: string; preview?: { success: number; failure: number } | null }) {
  const [counts, setCounts] = useState<{ success: number; failure: number } | null>(preview ?? null);

  useEffect(() => {
    if (preview !== undefined) return;
    let live = true;
    setCounts(null);
    jobOutcomes(fleetId, agentId, authKey).then(
      (all) => { if (live) setCounts(all?.[agentId] ?? null); },
      () => { if (live) setCounts(null); },
    );
    return () => { live = false; };
  }, [fleetId, agentId, authKey, preview]);

  const line = jobsLine(counts);
  if (!line) return null;
  return (
    <p className="wr-agent-health" data-tone={line.tone}>
      <span className="wr-agent-health__label">Jobs</span>
      <span>{line.text}</span>
    </p>
  );
}

/** The line, or null when nothing was reported. Warn tone once a fifth of jobs failed. */
export function jobsLine(c: { success: number; failure: number } | null): { text: string; tone: 'ok' | 'warn' } | null {
  if (!c) return null;
  const total = c.success + c.failure;
  if (total === 0) return null;
  const pct = Math.round((100 * c.success) / total);
  return { text: `${c.success} of ${total} succeeded (${pct}%) · last 7 days · reported by your system`, tone: c.failure / total >= 0.2 ? 'warn' : 'ok' };
}
