'use client';

import { FONT_MONO } from '@whiteroom/ui';
import type { ControlDefinition, ReadinessAssessment } from '@/lib/whiteroom/types';
import type { RunStatusResult, AgentInfo as SandboxAgentInfo } from '@/lib/sandbox/api';
import styles from './sandbox.module.css';

const ASSERTION_LABELS: Record<string, { label: string; hint: string; required: boolean }> = {
  basic_connect: { label: 'Connected', hint: 'Agent registered and first call proxied', required: true },
  watch_expiry: { label: 'Handoff created', hint: 'Watch expired and handover doc generated', required: true },
  handover_roundtrip: { label: 'Resumed after handoff', hint: 'New watch started with compressed context', required: true },
  context_compression: { label: 'Compression working', hint: 'Handover doc has compression ratio', required: false },
  compliance_gate: { label: 'Rest enforced', hint: 'Agent call rejected during mandatory rest period', required: false },
  graceful_disconnect: { label: 'Disconnect handled', hint: 'Agent went silent and watchdog recovered it', required: false },
  multi_agent_relay: { label: 'Multi-agent relay', hint: 'Paired agents handed off work to each other', required: false },
  policy_observed: { label: 'Policy observed', hint: 'Deny policy detected bash call in observe mode', required: false },
  policy_enforced: { label: 'Policy enforced', hint: 'Enforce mode blocked bash call from response', required: false },
  policy_decision_audited: { label: 'Decision audited', hint: 'Both decisions in verified audit chain', required: false },
};

function AssertionIcon({ status }: { status: string }) {
  if (status === 'observed') return <span style={{ color: 'var(--ok)', fontSize: 15, fontWeight: 700 }}>✓</span>;
  if (status === 'failed') return <span style={{ color: 'var(--bad)', fontSize: 15, fontWeight: 700 }}>✗</span>;
  return <span style={{ color: 'var(--tx3)', fontSize: 15 }}>○</span>;
}

function ControlIcon({ ctrl }: { ctrl: ControlDefinition }) {
  const live = ctrl.liveEligibility;
  if (live?.eligible && live.status === 'observed') return <span style={{ color: 'var(--ok)', fontSize: 15, fontWeight: 700 }}>✓</span>;
  if (live?.eligible && live.status === 'failed') return <span style={{ color: 'var(--bad)', fontSize: 15, fontWeight: 700 }}>✗</span>;
  if (ctrl.result.liveIncomplete) return <span style={{ color: 'var(--warn)', fontSize: 15, fontWeight: 700 }}>!</span>;
  if (ctrl.capability === 'unsupported') return <span style={{ color: 'var(--tx3)', fontSize: 13 }}>⊘</span>;
  return <span style={{ color: 'var(--tx3)', fontSize: 15 }}>○</span>;
}

interface ResultsListProps {
  experience: 'legacy' | 'new';
  status: RunStatusResult | null;
  controls: ControlDefinition[];
  readiness: ReadinessAssessment | null;
  demoRunning: boolean;
  demoSteps: unknown[];
  paused: Set<string>;
  selected: Set<string>;
  loading: boolean;
  canGoLive: boolean;
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

export function ResultsList({
  experience, status, controls, readiness, demoRunning, demoSteps, paused, selected, loading, canGoLive,
  onToggleSelect, onToggleSelectAll, onPauseAgent, onResumeAgent, onPauseAll, onResumeAll,
  onPauseSelected, onResumeSelected, onClearSelection, onStartDemo, onReset, onExportReport,
  onGoLive, onDestroy, onToggleRequired, onResetEvidence, onRemoveControl,
}: ResultsListProps) {
  const assertions = status?.assertionStates ?? {};
  const legacyRequiredPassed = Object.entries(assertions)
    .filter(([k]) => ASSERTION_LABELS[k]?.required)
    .every(([, v]) => v.status === 'observed');

  return (
    <div className={styles.splitLeft}>
      {experience === 'new' ? (
        <>
          <div className={styles.phaseTitle}>
            {demoRunning ? 'Running Demo' : readiness?.overall.status === 'pass' ? 'All Controls Passed' : controls.length > 0 ? 'Control Results' : 'Waiting for Activity'}
          </div>
          <p style={{ color: 'var(--tx2)', fontSize: 12.5, marginBottom: 14 }}>
            {demoRunning
              ? 'Simulating a full agent lifecycle — watch the controls update.'
              : readiness?.overall.status === 'pass'
                ? 'All required controls passed live verification. Ready to go live.'
                : controls.length > 0
                  ? 'Watching governance events. Controls update as evidence is collected.'
                  : 'Click "Run demo agent" below, or connect your own agent to begin testing.'}
          </p>

          {readiness && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
              <div style={{ padding: '6px 10px', borderRadius: 6, fontSize: 11.5, fontWeight: 600, fontFamily: FONT_MONO, background: readiness.liveReady ? 'var(--ok-bg, rgba(34,197,94,0.1))' : 'var(--sunk)', color: readiness.liveReady ? 'var(--ok)' : 'var(--tx3)', border: `1px solid ${readiness.liveReady ? 'var(--ok)' : 'var(--line)'}` }}>
                LIVE: {readiness.liveReady ? 'READY' : readiness.overall.status.toUpperCase()}
              </div>
              <div style={{ padding: '6px 10px', borderRadius: 6, fontSize: 11.5, fontWeight: 600, fontFamily: FONT_MONO, background: readiness.demoComplete ? 'var(--info-bg)' : 'var(--sunk)', color: readiness.demoComplete ? 'var(--info)' : 'var(--tx3)', border: `1px solid ${readiness.demoComplete ? 'var(--info)' : 'var(--line)'}` }}>
                DEMO: {readiness.demoComplete ? 'COMPLETE' : 'PENDING'}
              </div>
            </div>
          )}

          <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: 1, color: 'var(--tx3)', textTransform: 'uppercase', marginBottom: 6 }}>Controls</div>
          <div aria-live="polite" style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
            {controls.map(ctrl => {
              const live = ctrl.liveEligibility;
              const hasLiveEvidence = ctrl.result.liveEvidence != null;
              const hasDemoEvidence = ctrl.result.demoEvidence != null;
              const isStale = live && !live.eligible && live.reason;
              const borderColor = live?.eligible && live.status === 'observed' ? 'var(--ok)'
                : live?.eligible && live.status === 'failed' ? 'var(--bad)'
                : ctrl.result.liveIncomplete ? 'var(--warn)' : 'var(--line)';
              return (
                <div key={ctrl.controlId} className={styles.controlRow} style={{ borderColor }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <ControlIcon ctrl={ctrl} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: 12.5 }}>
                        {ctrl.name}
                        {!ctrl.required && <span style={{ fontSize: 10.5, color: 'var(--tx3)', marginLeft: 6, fontWeight: 500 }}>optional</span>}
                        {ctrl.capability === 'unsupported' && <span style={{ fontSize: 10.5, color: 'var(--warn)', marginLeft: 6, fontWeight: 600 }}>unsupported</span>}
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--tx3)', marginTop: 1 }}>{ctrl.description}</div>
                    </div>
                    <span style={{ fontSize: 10, fontFamily: FONT_MONO, color: 'var(--tx3)' }}>{ctrl.evaluator}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 12, marginTop: 8, paddingTop: 6, borderTop: '1px solid var(--line)' }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--tx3)', letterSpacing: 0.5, marginBottom: 2 }} title="Verified by your connected agent's real traffic">LIVE <span style={{ fontWeight: 400, fontSize: 9.5 }}>agent</span></div>
                      {hasLiveEvidence ? (
                        <div style={{ fontSize: 11.5, color: ctrl.result.liveEvidence!.status === 'observed' ? 'var(--ok)' : 'var(--bad)' }}>
                          {ctrl.result.liveEvidence!.status === 'observed' ? '✓ Observed' : '✗ Failed'}
                          {ctrl.result.liveEvidence!.diagnostic && <span style={{ color: 'var(--tx3)', marginLeft: 4 }}>— {ctrl.result.liveEvidence!.diagnostic}</span>}
                        </div>
                      ) : ctrl.result.liveIncomplete ? (
                        <div style={{ fontSize: 11.5, color: 'var(--warn)' }}>! Incomplete ({ctrl.result.liveIncomplete.droppedStatus})</div>
                      ) : (
                        <div style={{ fontSize: 11.5, color: 'var(--tx3)' }}>— No evidence</div>
                      )}
                      {isStale && <div style={{ fontSize: 10.5, color: 'var(--warn)', marginTop: 1 }}>{live!.reason}</div>}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--tx3)', letterSpacing: 0.5, marginBottom: 2 }} title="Simulated by the built-in demo agent">DEMO <span style={{ fontWeight: 400, fontSize: 9.5 }}>sim</span></div>
                      {hasDemoEvidence ? (
                        <div style={{ fontSize: 11.5, color: ctrl.result.demoEvidence!.status === 'observed' ? 'var(--info)' : 'var(--bad)' }}>
                          {ctrl.result.demoEvidence!.status === 'observed' ? '✓ Simulated' : '✗ Failed'}
                        </div>
                      ) : ctrl.result.demoIncomplete ? (
                        <div style={{ fontSize: 11.5, color: 'var(--warn)' }}>! Incomplete</div>
                      ) : (
                        <div style={{ fontSize: 11.5, color: 'var(--tx3)' }}>— No evidence</div>
                      )}
                    </div>
                  </div>
                  {ctrl.source !== 'core' && (
                    <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                      <button onClick={() => onToggleRequired(ctrl.controlId, !ctrl.requiredByUser)} className={styles.btnLink}>
                        {ctrl.requiredByUser ? 'Make optional' : 'Make required'}
                      </button>
                      <span style={{ color: 'var(--line2)' }}>·</span>
                      <button onClick={() => onResetEvidence(ctrl.controlId)} className={styles.btnLink} style={{ color: 'var(--tx3)' }}>
                        Reset evidence
                      </button>
                      {ctrl.source === 'custom' && (
                        <>
                          <span style={{ color: 'var(--line2)' }}>·</span>
                          <button onClick={() => onRemoveControl(ctrl.controlId)} className={styles.btnLink} style={{ color: 'var(--bad)' }}>
                            Remove
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div style={{ fontSize: 11.5, color: 'var(--tx3)', marginBottom: 16, fontFamily: FONT_MONO }}>
            {(() => {
              const req = controls.filter(c => c.required);
              const reqPassed = req.filter(c => c.liveEligibility?.eligible && c.liveEligibility.status === 'observed').length;
              const opt = controls.filter(c => !c.required);
              const optPassed = opt.filter(c => c.liveEligibility?.eligible && c.liveEligibility.status === 'observed').length;
              return `${reqPassed} of ${req.length} required · ${optPassed} of ${opt.length} optional`;
            })()}
          </div>
        </>
      ) : (
        <>
          <div className={styles.phaseTitle}>
            {demoRunning ? 'Running Demo' : legacyRequiredPassed ? 'All Checks Passed' : status?.agents?.length ? 'Running Checks' : demoSteps.length > 0 ? 'Demo Complete' : 'Waiting for Activity'}
          </div>
          <p style={{ color: 'var(--tx2)', fontSize: 12.5, marginBottom: 18 }}>
            {demoRunning
              ? 'Simulating a full agent lifecycle — watch the checks light up.'
              : legacyRequiredPassed
                ? 'All required governance checks passed. You can go live or run more tests.'
                : status?.agents?.length
                  ? 'Your agent is connected. Watching governance events.'
                  : demoSteps.length > 0
                    ? 'Demo finished. Review the results, then go live or run again.'
                    : 'Click "Run demo agent" below, or connect your own agent to begin testing.'}
          </p>

          <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: 1, color: 'var(--tx3)', textTransform: 'uppercase', marginBottom: 6 }}>Governance Checks</div>
          <div aria-live="polite" style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
            {Object.entries(ASSERTION_LABELS).map(([key, { label, hint, required }]) => {
              const a = assertions[key];
              const s = a?.status ?? 'waiting';
              return (
                <div key={key} className={styles.controlRow} style={{ display: 'flex', alignItems: 'center', gap: 10, borderColor: s === 'observed' ? 'var(--ok)' : s === 'failed' ? 'var(--bad)' : undefined }}>
                  <AssertionIcon status={s} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 12.5 }}>
                      {label}
                      {!required && <span style={{ fontSize: 10.5, color: 'var(--tx3)', marginLeft: 6, fontWeight: 500 }}>optional</span>}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--tx3)', marginTop: 1 }}>{hint}</div>
                    {s === 'failed' && a?.diagnostic && <div style={{ fontSize: 11.5, color: 'var(--bad)', marginTop: 3 }}>{a.diagnostic}</div>}
                    {s === 'observed' && a?.metric !== undefined && <div style={{ fontSize: 11, color: 'var(--ok)', marginTop: 2, fontFamily: FONT_MONO }}>{a.metric}% compression</div>}
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ fontSize: 11.5, color: 'var(--tx3)', marginBottom: 16, fontFamily: FONT_MONO }}>
            {(() => {
              const req = Object.entries(assertions).filter(([k]) => ASSERTION_LABELS[k]?.required);
              const reqPassed = req.filter(([, v]) => v.status === 'observed').length;
              const opt = Object.entries(assertions).filter(([k]) => !ASSERTION_LABELS[k]?.required);
              const optPassed = opt.filter(([, v]) => v.status === 'observed').length;
              return `${reqPassed} of ${req.length} required · ${optPassed} of ${opt.length} optional`;
            })()}
          </div>
        </>
      )}

      {/* Fleet Agents */}
      {status?.agents && status.agents.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: 1, color: 'var(--tx3)', textTransform: 'uppercase' }}>Sandbox Fleet</div>
            {status.agents.length > 1 && (
              <button onClick={onToggleSelectAll} className={styles.btnLink}>
                {selected.size === status.agents.length ? 'Deselect all' : 'Select all'}
              </button>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {status.agents.map((a: SandboxAgentInfo) => {
              const agentPaused = paused.has(a.agentId) || a.status === 'resting';
              const isSelected = selected.has(a.agentId);
              return (
                <div key={a.agentId} onClick={() => onToggleSelect(a.agentId)}
                  className={isSelected ? styles.agentCardSelected : styles.agentCard}
                  style={{ borderColor: isSelected ? undefined : agentPaused ? 'var(--warn)' : undefined }}>
                  <input type="checkbox" checked={isSelected} onChange={() => {}} style={{ accentColor: 'var(--brand)', width: 14, height: 14, flexShrink: 0, cursor: 'pointer' }} />
                  <span className={styles.statusDot} style={{ background: a.status === 'working' ? 'var(--ok)' : a.status === 'resting' ? 'var(--warn)' : 'var(--tx3)' }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, fontFamily: FONT_MONO }}>{a.agentId}</div>
                    <div style={{ fontSize: 11, color: 'var(--tx3)', marginTop: 1 }}>
                      {a.role} · {a.status}{a.pairedWith ? ` · paired → ${a.pairedWith}` : ''}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <div style={{ display: 'flex', gap: 10, fontSize: 11, fontFamily: FONT_MONO, color: 'var(--tx3)' }}>
                      <span>{a.totalTasks} tasks</span>
                      <span>{a.totalTokens.toLocaleString()} tok</span>
                      <span>{a.watchCount} watches</span>
                    </div>
                    {agentPaused ? (
                      <button onClick={(ev) => { ev.stopPropagation(); onResumeAgent(a.agentId); }} style={{ fontSize: 10.5, padding: '2px 8px', borderRadius: 4, background: 'var(--ok)', color: 'var(--bg)', border: 'none', cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap' }}>Resume</button>
                    ) : (
                      <button onClick={(ev) => { ev.stopPropagation(); onPauseAgent(a.agentId); }} style={{ fontSize: 10.5, padding: '2px 8px', borderRadius: 4, background: 'var(--warn)', color: 'var(--bg)', border: 'none', cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap' }}>Pause</button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Actions */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        {selected.size > 0 ? (
          <>
            <button onClick={onPauseSelected} disabled={loading} className={styles.btnWarn}>Pause selected ({selected.size})</button>
            <button onClick={onResumeSelected} disabled={loading} className={styles.btnPrimary}>Resume selected ({selected.size})</button>
            <button onClick={onClearSelection} className={styles.btnGhost}>Clear selection</button>
          </>
        ) : status?.agents && status.agents.length > 1 ? (
          paused.size === status.agents.length ? (
            <button onClick={onResumeAll} disabled={loading} className={styles.btnPrimary}>Resume all</button>
          ) : (
            <button onClick={onPauseAll} disabled={loading} className={styles.btnWarn}>Pause all</button>
          )
        ) : status?.agents?.length === 1 ? (
          paused.has(status.agents[0].agentId) || status.agents[0].status === 'resting' ? (
            <button onClick={() => onResumeAgent(status.agents![0].agentId)} disabled={loading} className={styles.btnPrimary}>Resume</button>
          ) : (
            <button onClick={() => onPauseAgent(status.agents![0].agentId)} disabled={loading} className={styles.btnWarn}>Pause</button>
          )
        ) : null}
        <button onClick={onStartDemo} disabled={loading || demoRunning}
          className={demoRunning ? styles.btnGhost : styles.btnSecondary}
          style={demoRunning ? { opacity: 0.5, cursor: 'not-allowed' } : { background: 'var(--ho-bg)', color: 'var(--ho)', border: '1px solid var(--ho)' }}>
          {demoRunning ? 'Demo running...' : 'Run demo agent'}
        </button>
        <button onClick={onReset} disabled={loading} className={styles.btnGhost}>Start over</button>
        <button onClick={onExportReport} className={styles.btnGhost}>Export JSON</button>
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        {canGoLive && (
          <button onClick={onGoLive} className={styles.btnSuccess} style={{ padding: '8px 20px' }}>Review production setup →</button>
        )}
        <button onClick={onDestroy} className={styles.btnDanger}>Destroy sandbox</button>
      </div>
    </div>
  );
}
