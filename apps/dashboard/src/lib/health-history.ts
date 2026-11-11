// Health history (Agent Health item 9): what the health checks found and
// what was done about it, for Agent detail's list and the Agent health
// report. Pure helpers; the reads are in lib/whiteroom/client.ts.

import type { HealthHistoryEvent } from '@/lib/whiteroom/client';
import type { FleetDiagnosis } from '@/lib/whiteroom/types';
import type { Sheet } from '@/lib/xlsx';
import { isDiagnosisDetector, TITLES } from '@/lib/diagnosis/copy';
import { userName, type ControlActor } from '@/lib/control-actors';

export const EVENT_LABEL: Record<HealthHistoryEvent['event'], string> = {
  opened: 'Found a problem',
  resolved: 'Stopped happening',
  snoozed: 'Snoozed',
  dismissed: 'Dismissed',
  marked_fixed: 'Marked fixed',
  alert_sent: 'Alert sent',
};

/** A finding's status in the report's words. */
const FINDING_STATUS: Record<string, string> = { open: 'Problem', snoozed: 'Snoozed', dismissed: 'Dismissed', reported_implemented: 'Marked fixed', resolved: 'Stopped happening' };

/** Days of history the report covers. */
export const REPORT_DAYS = 90;
/** Pages read for one report at most (the engine sends 200 events a page). */
export const REPORT_MAX_PAGES = 10;

export const checkName = (detector: string) => (isDiagnosisDetector(detector) ? TITLES[detector] : detector.replace(/^review_/, '').replace(/_/g, ' '));

/** Who acted: a person's name, "a teammate" when that person's name isn't known, else "WhiteRoom". */
export function whoActed(actor: string | null, actions: ControlActor[]): string {
  // userName names any "user:" actor, as "a teammate" when the name isn't known.
  return (actor?.startsWith('user:') && userName(actor, actions)) || 'WhiteRoom';
}

/** The UTC days from `days` ago to today, as the engine reads them. */
export function historyDays(days: number, now = Date.now()): { fromDay: string; toDay: string } {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { fromDay: day(now - (days - 1) * 86_400_000), toDay: day(now) };
}

/** Reads every page, up to `maxPages`; `truncated` when more were left, or a later page couldn't be read. */
export async function readAllHistory(
  read: (cursor: string | null) => Promise<{ events: HealthHistoryEvent[]; cursor: string | null } | null>,
  maxPages = REPORT_MAX_PAGES,
): Promise<{ events: HealthHistoryEvent[]; truncated: boolean } | null> {
  const events: HealthHistoryEvent[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const got = await read(cursor);
    // Null on the first page: no history on this engine. Later, the rest is missing.
    if (!got) return page === 0 ? null : { events, truncated: true };
    events.push(...got.events);
    cursor = got.cursor;
    if (!cursor) return { events, truncated: false };
  }
  return { events, truncated: true };
}

/**
 * The report as a workbook: each check's state today, per agent, then the
 * history. Agent ids and tool names are the customer's own text; the
 * workbook writes every text cell as text, never as a formula.
 */
export function healthReportSheets(
  diagnosis: FleetDiagnosis | null,
  history: HealthHistoryEvent[],
  actions: ControlActor[],
  fmt: (iso: string) => string,
): Sheet[] {
  const now: (string | number)[][] = [];
  for (const r of diagnosis?.reports ?? []) {
    for (const f of r.findings) now.push([r.agentId, checkName(f.detector), FINDING_STATUS[f.status] ?? f.status.replace(/_/g, ' ')]);
    for (const c of r.clear) now.push([r.agentId, checkName(c.detector), 'Passed']);
    for (const n of r.notMeasured) now.push([r.agentId, checkName(n.detector), 'Needs more data']);
  }
  return [
    { name: 'Checks today', header: ['Agent', 'Check', 'Status'], rows: now },
    { name: 'History', header: ['When', 'Agent', 'Check', 'What happened', 'By'], rows: history.map((e) => [fmt(e.at), e.agentId, checkName(e.detector), EVENT_LABEL[e.event] ?? e.event, whoActed(e.actor, actions)]) },
  ];
}
