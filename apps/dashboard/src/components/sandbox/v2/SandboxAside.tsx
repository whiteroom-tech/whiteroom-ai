'use client';

import Link from 'next/link';
import { RULE_LABELS } from '@/lib/governance';
import { keptUntilText, lastCallText, providerLabel, type SandboxFleetStatus } from '@/lib/sandbox/fleet';
import { rulesSummary, type SandboxRulesState } from '@/lib/sandbox/rules';
import { CALLING_MS } from '@/lib/sandbox/checks';
import { WHAT_WE_CHECK, WHAT_WE_CHECK_SUB, WHERE_WORDS } from '@/lib/sandbox/what-we-check';
import v from './v2.module.css';

// The Sandbox page's right-hand column (eight checks mockup Rev 3): lighter
// reference cards beside the current step. Each card shows the page's own
// data and runs the page's own actions; it stacks under the step on a phone.

type Connected = Extract<SandboxFleetStatus, { exists: true }>;

/** Your Sandbox: its provider and key, last call, URL, and the Sandbox's own actions. */
export function YourSandboxCard({ connected, lastCallAt, now, busy, onNewUrl, onChangeKey, onReset }: {
  connected: Connected;
  lastCallAt: string | null;
  now: number;
  busy: boolean;
  onNewUrl: () => void;
  onChangeKey: () => void;
  onReset: () => void;
}) {
  const sample = connected.sample === true;
  const key = connected.key!;
  const live = !!lastCallAt && now - Date.parse(lastCallAt) < CALLING_MS;
  return (
    <section className={v.rcard} aria-label="Your Sandbox">
      <h3 className={v.rcardHead}>Your Sandbox</h3>
      <div className={v.rrow}>
        <span className={`${v.rdot} ${live ? v.rdotLive : ''}`} aria-hidden="true" />
        {sample ? <b>Sample agent · run by WhiteRoom</b> : <><b>{providerLabel(key.provider)}</b> · key ending <span className={v.mono}>{key.keyHint}</span></>}
      </div>
      <div className={v.rrow}>Last call: {lastCallAt ? lastCallText(lastCallAt, now) : 'none yet'}</div>
      {!sample && <div className={v.rrow}>URL starts <span className={v.mono}>{key.prefix.replace(/\.+$/, '')}…</span></div>}
      <p className={v.rsub}>{keptUntilText(connected.expiresAt, now)}</p>
      <div className={v.ractions}>
        {!sample && <button type="button" className={v.sbtn} onClick={onNewUrl} disabled={busy}>New URL</button>}
        <button type="button" className={v.sbtn} onClick={onChangeKey} disabled={busy}>{sample ? 'Use your own key' : 'Change key'}</button>
      </div>
      <div className={v.rsep}><button type="button" className={v.dangerLink} onClick={onReset} disabled={busy}>Reset Sandbox…</button></div>
    </section>
  );
}

/** Sandbox rules: one chip per rule, where they came from and their modes, and Edit rules. */
export function SandboxRulesCard({ state, loadFailed = false, onEdit }: { state: SandboxRulesState | null; loadFailed?: boolean; onEdit: () => void }) {
  const rules = state?.rules ?? [];
  return (
    <section className={v.rcard} aria-label="Sandbox rules">
      <h3 className={v.rcardHead}>Sandbox rules</h3>
      {rules.length > 0 && <div className={v.pills}>{rules.map((r) => <span key={r.id} className={v.pill}>{RULE_LABELS[r.ruleType]}</span>)}</div>}
      <p className={v.rsub}>{loadFailed && !state ? 'Couldn’t load. Edit rules to try again.' : rulesSummary(state, true)}</p>
      <div className={v.ractions}><button type="button" className={v.sbtn} onClick={onEdit}>Edit rules</button></div>
    </section>
  );
}

/**
 * What we check: the eight rows in their groups, where each is checked, and
 * what it tests (opens per row). Rows checked in practice tasks link to them.
 */
export function WhatWeCheckCard({ open, practiceHref }: { open: boolean; practiceHref: string }) {
  return (
    <details className={`${v.rcard} ${v.rfold}`} open={open}>
      <summary className={v.rfoldHead}><h3 className={v.rcardHead}>What we check</h3></summary>
      <p className={v.rsub}>{WHAT_WE_CHECK_SUB}</p>
      {WHAT_WE_CHECK.map((g) => (
        <div key={g.name} className={v.wgrp}>
          <div className={v.wgrpHead}><b>{g.name}</b><span>{g.q}</span></div>
          <ul className={v.names}>
            {g.rows.map((r) => (
              <li key={r.num}>
                <details>
                  <summary>
                    <span className={v.rowt}>
                      <span className={v.rowNum}>{r.num}</span>
                      <span>{r.name}<span className={`${v.where} ${r.where !== 'here' ? v.wherePractice : ''}`}>{WHERE_WORDS[r.where]}</span></span>
                    </span>
                  </summary>
                  <p>{r.short}</p>
                  <p>{r.more}{r.where !== 'here' && <> <Link href={practiceHref} className="wr-link">Run practice tasks</Link></>}</p>
                </details>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </details>
  );
}

/** Next: the report's next steps, numbered. */
export function NextCard({ items }: { items: React.ReactNode[] }) {
  if (items.length === 0) return null;
  return (
    <section className={v.rcard} aria-label="Next">
      <h3 className={v.rcardHead}>Next</h3>
      <ol className={v.tips}>{items.map((x, i) => <li key={i}>{x}</li>)}</ol>
    </section>
  );
}
