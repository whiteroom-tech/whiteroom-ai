'use client';

import { useState } from 'react';
import { DataTable, Hint, Panel, FONT_MONO } from '@whiteroom/ui';
import type { AgentTotals, DaySavings } from '@/lib/analytics-metrics';
import { fmtTokens } from '@/lib/format';
import { HELP } from '@/lib/metric-definitions';

const PLOT_H = 120;

/**
 * The Savings card's caption, describing the same total as its value: tokens
 * shorter handovers didn't spend, plus prompt-cache reads billed at a discount.
 */
export function savingsCaption(handoverTokens: number, cacheMicros: number): string {
  const parts = [
    handoverTokens > 0 ? `${fmtTokens(handoverTokens)} tokens not spent` : null,
    cacheMicros > 0 ? 'cache reads' : null,
  ].filter(Boolean);
  return parts.length ? `${parts.join(' + ')}, a ceiling` : 'nothing saved in this range';
}

/** Round a max up to a tidy axis top, so the tallest bar fills most of the plot. */
export function axisTop(max: number): number {
  if (max <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * p).find((v) => v >= max) ?? 10 * p;
}

/** Axis labels: "150K", not "150.0K". */
export function axisLabel(n: number): string {
  return fmtTokens(n).replace(/\.0+(?=[KM])/, '');
}

function weekday(day: string): string {
  return new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short' });
}

/**
 * Savings (README › Performance): tokens with WhiteRoom against the ceiling
 * without it, for each of the last 7 days. Always 7 days, whatever the page
 * range; the header says so.
 */
export function SavingsChart({ days }: { days: DaySavings[] }) {
  const [focus, setFocus] = useState<string | null>(null);
  const top = axisTop(Math.max(...days.map((d) => d.used + d.saved), 0));
  const h = (n: number) => Math.max(n > 0 ? 2 : 0, Math.round((n / top) * PLOT_H));
  const empty = days.every((d) => d.used === 0 && d.saved === 0);
  const shown = days.find((d) => d.day === focus);

  return (
    <Panel title={<>Savings<Hint text={HELP.savings} /></>} count="last 7 days">
      {empty ? (
        <p style={{ margin: 0, fontSize: 13, color: 'var(--tx2)' }}>No model calls in the last 7 days.</p>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '44px minmax(0, 1fr)', gap: 8 }}>
            <div aria-hidden="true" style={{ position: 'relative', height: PLOT_H, fontFamily: FONT_MONO, fontSize: 10.5, color: 'var(--tx2)' }}>
              {[top, top / 2, 0].map((v, i) => (
                <span key={i} style={{ position: 'absolute', right: 0, top: `${(i / 2) * 100}%`, transform: 'translateY(-50%)' }}>{axisLabel(v)}</span>
              ))}
            </div>
            <div style={{ position: 'relative' }}>
              <div aria-hidden="true" style={{ position: 'absolute', inset: `0 0 auto 0`, height: PLOT_H }}>
                {[0, 0.5, 1].map((f) => (
                  <div key={f} style={{ position: 'absolute', left: 0, right: 0, top: `${f * 100}%`, borderTop: '1px dashed var(--line)' }} />
                ))}
              </div>
              <div role="list" aria-label="Tokens per day, last 7 days" style={{ position: 'relative', display: 'grid', gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))`, gap: 6 }}>
                {days.map((d) => {
                  const without = d.used + d.saved;
                  const label = `${weekday(d.day)}: ${fmtTokens(d.used)} tokens with WhiteRoom, up to ${fmtTokens(without)} without`;
                  return (
                    <div
                      key={d.day}
                      role="listitem"
                      tabIndex={0}
                      aria-label={label}
                      title={label}
                      onMouseEnter={() => setFocus(d.day)}
                      onMouseLeave={() => setFocus(null)}
                      onFocus={() => setFocus(d.day)}
                      onBlur={() => setFocus(null)}
                      className="wr-savings-day"
                    >
                      <div style={{ height: PLOT_H, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: 3 }}>
                        <div style={{ width: 12, height: h(d.used), background: 'var(--brand)', borderRadius: '2px 2px 0 0' }} />
                        <div style={{ width: 12, height: h(without), background: 'var(--line2)', borderRadius: '2px 2px 0 0' }} />
                      </div>
                      <div style={{ marginTop: 6, textAlign: 'center', fontFamily: FONT_MONO, fontSize: 10.5, color: 'var(--tx2)' }}>{weekday(d.day)}</div>
                      <div style={{ textAlign: 'center', fontFamily: FONT_MONO, fontSize: 10.5, color: 'var(--tx)', whiteSpace: 'nowrap' }}>
                        {without ? `${fmtTokens(d.used)} / ${fmtTokens(without)}` : '–'}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 12, fontSize: 12, color: 'var(--tx2)', flexWrap: 'wrap' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--brand)' }} />With WhiteRoom</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--line2)' }} />Without, up to</span>
            <span aria-live="polite" style={{ marginLeft: 'auto', fontFamily: FONT_MONO, fontSize: 11.5, color: 'var(--tx)' }}>
              {shown ? `${weekday(shown.day)}: ${fmtTokens(shown.used)} tokens with WhiteRoom, up to ${fmtTokens(shown.used + shown.saved)} without` : ''}
            </span>
          </div>
        </>
      )}
    </Panel>
  );
}

/**
 * By agent (README › Performance), moved from Run History: tokens and savings
 * per agent for the page's range, most tokens first. Rule actions, flagged
 * runs and claim check join it with the governance engine (P2).
 */
export function ByAgentTable({ rows, scope, ruleActions }: {
  rows: AgentTotals[];
  scope: string;
  /** Controls blocks (Enforce) and would-blocks (Watch only) per agent id, lower-cased. */
  ruleActions?: Record<string, { blocks: number; wouldBlocks: number }>;
}) {
  return (
    <Panel title={<>By agent<Hint text={HELP.byAgent} /></>} count={`${rows.length} · ${scope}`} bodyPadding={0}>
      {rows.length === 0 ? (
        <p style={{ margin: 0, padding: '14px 18px', fontSize: 13, color: 'var(--tx2)' }}>No agent activity in this range.</p>
      ) : (
        <DataTable<AgentTotals>
          caption="Tokens and savings by agent"
          rows={rows}
          rowKey={(r) => r.agent}
          rowHeight={40}
          columns={[
            {
              key: 'agent', header: 'Agent', width: 'minmax(160px, 1.4fr)',
              render: (r) => r.agent
                ? <span style={{ fontFamily: FONT_MONO, fontWeight: 500 }}>{r.agent}</span>
                : <span style={{ color: 'var(--tx2)' }} title="Model calls recorded without an agent name">Unattributed</span>,
            },
            { key: 'tokens', header: 'Tokens', width: '120px', numeric: true, render: (r) => fmtTokens(r.used) },
            { key: 'saved', header: 'Saved, up to', width: '120px', numeric: true, render: (r) => (r.saved > 0 ? fmtTokens(r.saved) : '–') },
            {
              key: 'rules', header: 'Rule actions', width: '180px', numeric: true,
              render: (r) => {
                const t = ruleActions?.[r.agent];
                if (!t || (!t.blocks && !t.wouldBlocks)) return <span style={{ color: 'var(--tx2)' }}>–</span>;
                return (
                  <span title="Calls a Controls rule blocked (Enforce), and calls it would have blocked (Watch only)">
                    {t.blocks > 0 && <span style={{ color: 'var(--bad)' }}>{t.blocks} blocked</span>}
                    {t.blocks > 0 && t.wouldBlocks > 0 && ' · '}
                    {t.wouldBlocks > 0 && <span style={{ color: 'var(--warn)' }}>{t.wouldBlocks} would block</span>}
                  </span>
                );
              },
            },
          ]}
        />
      )}
    </Panel>
  );
}
