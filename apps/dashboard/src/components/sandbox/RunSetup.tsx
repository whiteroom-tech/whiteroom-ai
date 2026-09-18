'use client';

import { FONT_MONO } from '@whiteroom/ui';
import type { CatalogEntry } from '@/lib/whiteroom/types';
import styles from './sandbox.module.css';

const CONTROL_HINTS: Record<string, string> = {
  'core.connect': 'Verifies your agent can reach the WhiteRoom proxy and that its first API call is successfully intercepted.',
  'core.handoff': 'Confirms the agent produces a handover document when its watch timer expires, so context is preserved between shifts.',
  'core.resume': 'Checks that an agent can pick up work using the compressed context from a prior handover — the continuity guarantee.',
  'cat.compression': 'Measures context compression ratio during handovers. Enable to verify that handover docs are actually smaller than raw context.',
  'cat.rest': 'Confirms agents are blocked from working during mandatory rest periods — the labor-compliance gate.',
  'cat.disconnect': 'Tests that the watchdog detects a silent or crashed agent and recovers the session gracefully.',
  'cat.relay': 'Validates multi-agent relay: paired agents can hand off tasks to each other mid-workflow.',
  'cat.deny': 'Verifies the policy engine detects disallowed tool calls (e.g., bash) in observe mode and logs the violation.',
  'cat.enforce': 'Confirms enforce mode actively strips disallowed tool calls from responses before they reach the agent.',
  'cat.audit': 'Checks that every policy decision — observe and enforce — appears in the verified audit chain with correct outcomes.',
};

interface RecommendPhaseProps {
  catalog: CatalogEntry[];
  selectedCatalogIds: Set<string>;
  onToggleControl: (controlId: string) => void;
  onApplyPreset: (mode: 'recommended' | 'full' | 'minimal') => void;
  onSelectAll: (tier: string, tierControlIds: string[], allSelected: boolean) => void;
  onNext: () => void;
  onBack: () => void;
}

export function RecommendPhase({
  catalog, selectedCatalogIds, onToggleControl, onApplyPreset, onSelectAll, onNext, onBack,
}: RecommendPhaseProps) {
  const coreIds = new Set(catalog.filter(c => c.tier === 'core').map(c => c.controlId));
  const totalSelected = selectedCatalogIds.size;
  const totalAvailable = catalog.length;

  return (
    <div style={{ maxWidth: 580, margin: '24px auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
        <div className={styles.phaseTitle}>Select Controls</div>
        <span style={{ fontSize: 12, fontFamily: FONT_MONO, color: 'var(--brand)', fontWeight: 600 }}>
          {totalSelected} of {totalAvailable} selected
        </span>
      </div>
      <p className={styles.phaseSubtitle}>
        Choose which governance controls to enable. Core controls are always active. Toggle optional controls based on your requirements.
      </p>

      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        <button onClick={() => onApplyPreset('recommended')} className={styles.btnGhost} style={{ fontSize: 11.5, padding: '4px 10px' }}>Recommended</button>
        <button onClick={() => onApplyPreset('full')} className={styles.btnGhost} style={{ fontSize: 11.5, padding: '4px 10px' }}>Full suite</button>
        <button onClick={() => onApplyPreset('minimal')} className={styles.btnGhost} style={{ fontSize: 11.5, padding: '4px 10px' }}>Core only</button>
      </div>

      {(['core', 'governance', 'policy'] as const).map(tier => {
        const tierControls = catalog.filter(c => c.tier === tier);
        if (tierControls.length === 0) return null;
        const tierSelected = tierControls.filter(c => selectedCatalogIds.has(c.controlId)).length;
        const allTierIds = tierControls.map(c => c.controlId);
        const allSelected = allTierIds.every(id => selectedCatalogIds.has(id));
        return (
          <div key={tier} style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: 1, color: 'var(--tx3)', textTransform: 'uppercase' }}>
                {tier === 'core' ? 'Core (always active)' : tier === 'governance' ? 'Governance (optional)' : 'Policy (optional)'}
              </div>
              {tier !== 'core' && (
                <button onClick={() => onSelectAll(tier, allTierIds, allSelected)} className={styles.btnLink}>
                  {tierSelected === tierControls.length ? 'Clear all' : 'Select all'}
                </button>
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {tierControls.map(entry => {
                const isCore = tier === 'core';
                const isSelected = selectedCatalogIds.has(entry.controlId);
                const hint = CONTROL_HINTS[entry.controlId];
                return (
                  <div
                    key={entry.controlId}
                    onClick={() => { if (!isCore) onToggleControl(entry.controlId); }}
                    style={{
                      display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', borderRadius: 6,
                      background: 'var(--card)', border: `1px solid ${isSelected ? 'var(--brand)' : 'var(--line)'}`,
                      cursor: isCore ? 'default' : 'pointer', opacity: isCore ? 0.85 : 1, transition: 'border-color 0.15s',
                    }}
                  >
                    <input type="checkbox" checked={isSelected} disabled={isCore} onChange={() => {}}
                      style={{ accentColor: 'var(--brand)', width: 14, height: 14, flexShrink: 0, cursor: isCore ? 'default' : 'pointer', marginTop: 1 }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: 12.5 }}>{entry.name}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--tx3)', marginTop: 1 }}>{entry.description}</div>
                      {hint && (
                        <div style={{ fontSize: 11.5, color: 'var(--tx2)', marginTop: 4, lineHeight: 1.5, paddingTop: 4, borderTop: '1px solid var(--line)' }}>
                          {hint}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      <div style={{ display: 'flex', gap: 10, marginTop: 8, alignItems: 'center' }}>
        <button onClick={onNext} className={styles.btnPrimary} style={{ padding: '8px 20px' }}>Next: Configure →</button>
        <button onClick={onBack} className={styles.btnGhost}>Back</button>
      </div>
    </div>
  );
}

interface ConfigurePhaseProps {
  catalog: CatalogEntry[];
  selectedCatalogIds: Set<string>;
  apiKeyInput: string;
  onApiKeyChange: (value: string) => void;
  policyMode: 'observe' | 'enforce';
  onPolicyModeChange: (mode: 'observe' | 'enforce') => void;
  loading: boolean;
  onCreateSandbox: () => void;
  onEditSelection: () => void;
  onBack: () => void;
}

export function ConfigurePhase({
  catalog, selectedCatalogIds, apiKeyInput, onApiKeyChange, policyMode, onPolicyModeChange,
  loading, onCreateSandbox, onEditSelection, onBack,
}: ConfigurePhaseProps) {
  const keyValid = apiKeyInput.startsWith('sk-ant-');
  const keyStarted = apiKeyInput.length > 0;
  const keyLooksWrong = keyStarted && apiKeyInput.startsWith('sk-') && !apiKeyInput.startsWith('sk-ant-');
  const keyTooShort = keyStarted && !apiKeyInput.startsWith('sk-');
  const canCreate = keyValid && !loading;

  const coreCatalog = catalog.filter(c => c.tier === 'core');
  const govCatalog = catalog.filter(c => c.tier === 'governance');
  const polCatalog = catalog.filter(c => c.tier === 'policy');
  const selectedCore = coreCatalog.filter(c => selectedCatalogIds.has(c.controlId));
  const selectedGov = govCatalog.filter(c => selectedCatalogIds.has(c.controlId));
  const selectedPol = polCatalog.filter(c => selectedCatalogIds.has(c.controlId));

  return (
    <div style={{ maxWidth: 520, margin: '24px auto' }}>
      <div className={styles.phaseTitle} style={{ marginBottom: 6 }}>Configure Sandbox</div>
      <p className={styles.phaseSubtitle}>
        Set your API credentials and enforcement mode before creating the sandbox.
      </p>

      <div className={styles.card} style={{ borderColor: keyValid ? 'var(--ok)' : keyTooShort || keyLooksWrong ? 'var(--bad)' : undefined, marginBottom: 16, transition: 'border-color 0.2s' }}>
        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--tx2)' }}>
          Your Anthropic API key
        </label>
        <div style={{ position: 'relative' }}>
          <input
            type="password"
            placeholder="sk-ant-..."
            value={apiKeyInput}
            onChange={(e) => onApiKeyChange(e.target.value)}
            style={{ width: '100%', padding: '8px 12px', paddingRight: 32, borderRadius: 6, border: `1px solid ${keyValid ? 'var(--ok)' : keyTooShort || keyLooksWrong ? 'var(--bad)' : 'var(--line2)'}`, background: 'var(--sunk)', color: 'var(--tx)', fontFamily: FONT_MONO, fontSize: 12, boxSizing: 'border-box', transition: 'border-color 0.2s' }}
          />
          {keyValid && <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--ok)', fontSize: 14, fontWeight: 700 }}>✓</span>}
        </div>
        {keyLooksWrong && <div style={{ fontSize: 11.5, color: 'var(--bad)', marginTop: 4, fontWeight: 500 }}>This looks like a non-Anthropic key. WhiteRoom needs an Anthropic key starting with sk-ant-.</div>}
        {keyTooShort && <div style={{ fontSize: 11.5, color: 'var(--tx3)', marginTop: 4 }}>Paste your Anthropic API key (starts with sk-ant-).</div>}
        {keyValid && <div style={{ fontSize: 11.5, color: 'var(--ok)', marginTop: 4, fontWeight: 500 }}>Key format valid.</div>}
        {!keyStarted && <p style={{ fontSize: 11.5, color: 'var(--tx3)', marginTop: 4, marginBottom: 0 }}>Used to forward calls to Anthropic. Never stored — only a hash is kept for ownership verification.</p>}
      </div>

      <div className={styles.card} style={{ marginBottom: 16 }}>
        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 8, color: 'var(--tx2)' }}>Policy Mode</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => onPolicyModeChange('observe')} style={{
            flex: 1, padding: '10px 12px', borderRadius: 6, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
            background: policyMode === 'observe' ? 'var(--warn-bg)' : 'var(--sunk)',
            color: policyMode === 'observe' ? 'var(--warn)' : 'var(--tx3)',
            border: `1.5px solid ${policyMode === 'observe' ? 'var(--warn)' : 'var(--line)'}`,
          }}>
            Observe
            <div style={{ fontSize: 11, fontWeight: 400, marginTop: 2 }}>Detect violations, log them, don&apos;t block</div>
          </button>
          <button onClick={() => onPolicyModeChange('enforce')} style={{
            flex: 1, padding: '10px 12px', borderRadius: 6, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
            background: policyMode === 'enforce' ? 'var(--bad-bg, rgba(239,68,68,0.1))' : 'var(--sunk)',
            color: policyMode === 'enforce' ? 'var(--bad)' : 'var(--tx3)',
            border: `1.5px solid ${policyMode === 'enforce' ? 'var(--bad)' : 'var(--line)'}`,
          }}>
            Enforce
            <div style={{ fontSize: 11, fontWeight: 400, marginTop: 2 }}>Detect violations and strip them from responses</div>
          </button>
        </div>
      </div>

      <div className={styles.card} style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--tx2)' }}>Selected Controls</div>
          <button onClick={onEditSelection} className={styles.btnLink} style={{ fontSize: 11.5 }}>Edit selection</button>
        </div>
        {selectedCore.length > 0 && (
          <div style={{ fontSize: 11.5, marginBottom: 4 }}>
            <span style={{ color: 'var(--tx3)', fontWeight: 600 }}>Core:</span>{' '}
            <span style={{ color: 'var(--tx2)' }}>{selectedCore.map(c => c.name).join(', ')}</span>
          </div>
        )}
        {selectedGov.length > 0 && (
          <div style={{ fontSize: 11.5, marginBottom: 4 }}>
            <span style={{ color: 'var(--tx3)', fontWeight: 600 }}>Governance:</span>{' '}
            <span style={{ color: 'var(--tx2)' }}>{selectedGov.map(c => c.name).join(', ')}</span>
          </div>
        )}
        {selectedPol.length > 0 && (
          <div style={{ fontSize: 11.5, marginBottom: 4 }}>
            <span style={{ color: 'var(--tx3)', fontWeight: 600 }}>Policy:</span>{' '}
            <span style={{ color: 'var(--tx2)' }}>{selectedPol.map(c => c.name).join(', ')}</span>
          </div>
        )}
        {selectedGov.length === 0 && selectedPol.length === 0 && (
          <div style={{ fontSize: 11.5, color: 'var(--tx3)' }}>Core controls only — no optional controls selected.</div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button onClick={onCreateSandbox} disabled={!canCreate} className={styles.btnPrimary}
          style={{ padding: '8px 20px', opacity: canCreate ? 1 : 0.5, cursor: canCreate ? 'pointer' : 'not-allowed' }}>
          {loading ? 'Creating sandbox...' : 'Create sandbox'}
        </button>
        <button onClick={onBack} className={styles.btnGhost}>Back</button>
        {!canCreate && !loading && (
          <span style={{ fontSize: 11.5, color: 'var(--tx3)' }}>
            {keyStarted ? 'Enter a valid Anthropic key to continue' : 'Enter your API key to continue'}
          </span>
        )}
      </div>
    </div>
  );
}
