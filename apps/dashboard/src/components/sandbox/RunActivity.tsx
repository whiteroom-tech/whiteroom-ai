'use client';

import { FONT_MONO } from '@whiteroom/ui';
import { ActivityFeed } from '@/components/ActivityFeed';
import type { AuditEntry } from '@/lib/whiteroom/types';
import type { DemoStep } from '@/lib/sandbox/api';
import type { FeedVariant } from '@/lib/activity';
import styles from './sandbox.module.css';

interface RunActivityProps {
  auditEntries: AuditEntry[];
  demoSteps: DemoStep[];
  visibleSteps: number;
  feedPage: number;
  onPageChange: (page: number) => void;
  feedVariant: FeedVariant;
  onVariantChange: (v: FeedVariant) => void;
  feedTechnical: boolean;
  onTechnicalToggle: () => void;
  expandedTasks: Set<string>;
  onToggleExpanded: (key: string) => void;
}

export function RunActivity({
  auditEntries, demoSteps, visibleSteps, feedPage, onPageChange,
  feedVariant, onVariantChange, feedTechnical, onTechnicalToggle,
  expandedTasks, onToggleExpanded,
}: RunActivityProps) {
  return (
    <div className={styles.splitRight}>
      <div className={styles.activityHeader}>
        <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: 1, color: 'var(--tx2)', textTransform: 'uppercase' }}>Agent Activity</span>
        <span style={{ flex: 1 }} />
        <select
          value={feedVariant}
          onChange={(e) => onVariantChange(e.target.value as FeedVariant)}
          style={{ borderRadius: 4, padding: '3px 6px', fontSize: 11.5, background: 'var(--sunk)', color: 'var(--tx2)', border: '1px solid var(--line2)' }}
        >
          <option value="log">▤ Log</option>
          <option value="tape">⛓ Tape</option>
          <option value="manifest">▦ Manifest</option>
        </select>
        <button
          onClick={onTechnicalToggle}
          style={{
            borderRadius: 4, padding: '4px 8px', fontSize: 11.5, fontWeight: 600, letterSpacing: 0.3, cursor: 'pointer',
            border: `1px solid ${feedTechnical ? 'var(--info)' : 'var(--line2)'}`,
            background: feedTechnical ? 'var(--info-bg)' : 'var(--sunk)',
            color: feedTechnical ? 'var(--info)' : 'var(--tx2)',
          }}
        >
          Tech
        </button>
        <span style={{ fontSize: 11.5, fontFamily: FONT_MONO, color: 'var(--tx3)' }}>
          {auditEntries.length} events
        </span>
      </div>

      {demoSteps.length > 0 && visibleSteps < demoSteps.length && (
        <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--line)', background: 'var(--brand-bg, rgba(0,210,211,0.06))', flexShrink: 0 }}>
          <div style={{ fontSize: 11.5, color: 'var(--brand)', fontFamily: FONT_MONO }}>● Demo running... step {visibleSteps} of {demoSteps.length}</div>
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <ActivityFeed
          entries={auditEntries}
          page={feedPage}
          onPageChange={onPageChange}
          variant={feedVariant}
          technical={feedTechnical}
          expanded={expandedTasks}
          onToggleExpanded={onToggleExpanded}
        />
      </div>
    </div>
  );
}
