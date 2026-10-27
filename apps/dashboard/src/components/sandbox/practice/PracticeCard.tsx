'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { getPracticeRun, listPracticeRuns } from '@/lib/sandbox/practice/api';
import { isOpen, PRACTICE_TASKS, progressLine, usualMinutes } from '@/lib/sandbox/practice/model';
import type { PracticeRun, PracticeRunRow } from '@/lib/sandbox/practice/types';
import { ROUTES } from '@/lib/routes';
import s from '../guided.module.css';
import p from './practice.module.css';

export interface PracticeEntry {
  fleet: string | null;
  /** The owner's practice tests; null until loaded, or when practice tests aren't available. */
  rows: PracticeRunRow[] | null;
  /** The test still open, with its progress. */
  open: PracticeRun | null;
}

/**
 * What the Sandbox start screen knows about practice tests: the fleet, its
 * owner's tests and the open one. Loaded only while `enabled`. Quiet on any
 * failure: with practice tests off on the engine, the card and rows just
 * don't appear.
 */
export function usePracticeEntry(enabled: boolean, preview?: PracticeEntry): PracticeEntry {
  const [entry, setEntry] = useState<PracticeEntry>(preview ?? { fleet: null, rows: null, open: null });
  useEffect(() => {
    if (!enabled || preview) return;
    let live = true;
    (async () => {
      const session = await fetch('/api/fleet/session', { credentials: 'same-origin', cache: 'no-store' }).then((r) => (r.ok ? r.json() : null));
      const fleet: string | undefined = session?.fleetId;
      if (!fleet) return;
      const rows = await listPracticeRuns(fleet);
      const openRow = rows.find((r) => isOpen(r.lifecycle));
      const open = openRow ? await getPracticeRun(fleet, openRow.id).catch(() => null) : null;
      if (live) setEntry({ fleet, rows, open });
    })().catch(() => {});
    return () => { live = false; };
  }, [enabled, preview]);
  return entry;
}

/** Sandbox start screen: the way into practice tests, or the one in progress. */
export function PracticeCard({ entry }: { entry: PracticeEntry }) {
  if (!entry.fleet || !entry.rows) return null;
  const { open } = entry;
  return (
    <div className={p.entryCard}>
      <SettingsCard
        id="practice-card"
        title={open ? 'Your practice test' : 'Try your agent on practice tasks'}
        sub={open
          ? (open.lifecycle === 'draft' ? 'Waiting for you to run it from your computer.' : open.lifecycle === 'finalizing' ? 'Finished. Working out the result.' : progressLine(open, Date.now()))
          : `${PRACTICE_TASKS} practice tasks and a check of your rules · about ${usualMinutes(1)} · about 50 model calls on your key`}
      >
        {open
          ? <Link className={`${s.btn} ${s.btnPrimary}`} href={`${ROUTES.practiceTest}?run=${open.id}`}>Open it →</Link>
          : <Link className={`${s.btn} ${s.btnSecondary}`} href={ROUTES.practiceTest}>Set up a practice test →</Link>}
      </SettingsCard>
    </div>
  );
}
