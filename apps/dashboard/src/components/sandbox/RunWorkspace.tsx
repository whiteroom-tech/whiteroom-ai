'use client';

import type { ControlDefinition, ReadinessAssessment } from '@/lib/whiteroom/types';
import type { AuditEntry } from '@/lib/whiteroom/types';
import type { RunStatusResult, DemoStep } from '@/lib/sandbox/api';
import type { FeedVariant } from '@/lib/activity';
import { ResultsList } from './ResultsList';
import { RunActivity } from './RunActivity';
import styles from './sandbox.module.css';

interface RunWorkspaceProps {
  experience: 'legacy' | 'new';
  status: RunStatusResult | null;
  controls: ControlDefinition[];
  readiness: ReadinessAssessment | null;
  demoRunning: boolean;
  demoSteps: DemoStep[];
  visibleSteps: number;
  paused: Set<string>;
  selected: Set<string>;
  loading: boolean;
  canGoLive: boolean;
  auditEntries: AuditEntry[];
  feedPage: number;
  onFeedPageChange: (page: number) => void;
  feedVariant: FeedVariant;
  onFeedVariantChange: (v: FeedVariant) => void;
  feedTechnical: boolean;
  onFeedTechnicalToggle: () => void;
  expandedTasks: Set<string>;
  onToggleExpanded: (key: string) => void;
  onToggleSelect: (agentId: string) => void;
  onToggleSelectAll: () => void;
  onPauseAgent: (agentId: string) => void;
  onResumeAgent: (agentId: string) => void;
  onPauseAll: () => void;
  onResumeAll: () => void;
  onPauseSelected: () => void;
  onResumeSelected: () => void;
  onClearSelection: () => void;
  onStartDemo: () => void;
  onReset: () => void;
  onExportReport: () => void;
  onGoLive: () => void;
  onDestroy: () => void;
  onToggleRequired: (controlId: string, required: boolean) => void;
  onResetEvidence: (controlId: string) => void;
  onRemoveControl: (controlId: string) => void;
}

export function RunWorkspace(props: RunWorkspaceProps) {
  return (
    <div className={styles.splitPanel}>
      <ResultsList
        experience={props.experience}
        status={props.status}
        controls={props.controls}
        readiness={props.readiness}
        demoRunning={props.demoRunning}
        demoSteps={props.demoSteps}
        paused={props.paused}
        selected={props.selected}
        loading={props.loading}
        canGoLive={props.canGoLive}
        onToggleSelect={props.onToggleSelect}
        onToggleSelectAll={props.onToggleSelectAll}
        onPauseAgent={props.onPauseAgent}
        onResumeAgent={props.onResumeAgent}
        onPauseAll={props.onPauseAll}
        onResumeAll={props.onResumeAll}
        onPauseSelected={props.onPauseSelected}
        onResumeSelected={props.onResumeSelected}
        onClearSelection={props.onClearSelection}
        onStartDemo={props.onStartDemo}
        onReset={props.onReset}
        onExportReport={props.onExportReport}
        onGoLive={props.onGoLive}
        onDestroy={props.onDestroy}
        onToggleRequired={props.onToggleRequired}
        onResetEvidence={props.onResetEvidence}
        onRemoveControl={props.onRemoveControl}
      />
      <RunActivity
        auditEntries={props.auditEntries}
        demoSteps={props.demoSteps}
        visibleSteps={props.visibleSteps}
        feedPage={props.feedPage}
        onPageChange={props.onFeedPageChange}
        feedVariant={props.feedVariant}
        onVariantChange={props.onFeedVariantChange}
        feedTechnical={props.feedTechnical}
        onTechnicalToggle={props.onFeedTechnicalToggle}
        expandedTasks={props.expandedTasks}
        onToggleExpanded={props.onToggleExpanded}
      />
    </div>
  );
}
