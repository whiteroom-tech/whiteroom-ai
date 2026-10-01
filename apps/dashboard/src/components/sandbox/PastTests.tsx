'use client';

import { useEffect, useState } from 'react';
import { DataTable, Hint, Panel, Tag, FONT_MONO } from '@whiteroom/ui';
import { getHistory, type PastTest } from '@/lib/sandbox/api';
import { HELP } from '@/lib/metric-definitions';

const RESULT: Record<PastTest['overall'], { label: string; tone: 'brand' | 'warn' | 'muted' }> = {
  pass: { label: 'All checks passed', tone: 'brand' },
  partial: { label: 'Some checks passed', tone: 'warn' },
  fail: { label: 'Checks didn’t pass', tone: 'muted' },
};

/** "Sep 30, 1:52 pm" in the viewer's time zone. */
function ended(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, ' ').toLowerCase()}`;
}

/**
 * Sandbox › Past tests (README › Screens › 7b): the owner's finished tests,
 * newest first. The engine keeps them across restarts. Hidden until there is
 * at least one, and quiet if the list can't be loaded.
 */
export function PastTests({ refreshKey, preview }: { refreshKey?: unknown; preview?: PastTest[] }) {
  const [tests, setTests] = useState<PastTest[] | null>(preview ?? null);

  useEffect(() => {
    if (preview) return;
    let live = true;
    getHistory().then((r) => { if (live && Array.isArray(r.sessions)) setTests([...r.sessions].reverse()); }, () => {});
    return () => { live = false; };
  }, [refreshKey, preview]);

  if (!tests?.length) return null;
  return (
    <div style={{ marginTop: 24 }}>
      <Panel title={<>Past tests<Hint text={HELP.pastTests} /></>} count={String(tests.length)} bodyPadding={0}>
        <DataTable<PastTest>
          caption="Past tests, newest first"
          rows={tests}
          rowKey={(t) => t.sandboxId}
          rowHeight={40}
          columns={[
            { key: 'when', header: 'Ended', width: '150px', render: (t) => <span style={{ fontFamily: FONT_MONO, color: 'var(--tx2)' }}>{ended(t.destroyedAt)}</span> },
            { key: 'result', header: 'Result', width: 'minmax(160px, 1fr)', render: (t) => <Tag tone={RESULT[t.overall]?.tone ?? 'muted'}>{RESULT[t.overall]?.label ?? t.overall}</Tag> },
            { key: 'calls', header: 'Tasks', width: '72px', numeric: true, render: (t) => String(t.totalTasks) },
            { key: 'kind', header: 'Kind', width: '90px', render: (t) => <span style={{ color: 'var(--tx2)' }}>{t.isTrial ? 'Demo' : 'Your agent'}</span> },
          ]}
        />
      </Panel>
    </div>
  );
}
