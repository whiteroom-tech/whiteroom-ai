// Agent health › Download report (Agent Health item 9): each check's state
// today and the last 90 days of Health history, as an Excel workbook like the
// Runs export.

import { healthHistory } from '@/lib/whiteroom/client';
import type { FleetDiagnosis } from '@/lib/whiteroom/types';
import { buildWorkbook, downloadWorkbook } from '@/lib/xlsx';
import { fetchControlActors } from '@/lib/control-actors';
import { formatInZone } from '@/lib/zone-time';
import { healthReportSheets, historyDays, readAllHistory, REPORT_DAYS } from '@/lib/health-history';

/** Builds and downloads the report. Resolves to an error to show, or null when it downloaded. */
export async function downloadHealthReport(fleetId: string, diagnosis: FleetDiagnosis | null, authKey?: string): Promise<string | null> {
  const days = historyDays(REPORT_DAYS);
  const read = await readAllHistory((cursor) => healthHistory(fleetId, { ...days, cursor }, authKey));
  if (!read) return 'Health history isn’t available on this engine yet.';
  const oldestActor = [...read.events].reverse().find((e) => e.actor);
  const actions = oldestActor ? await fetchControlActors(fleetId, oldestActor.at) : [];
  const fmt = (iso: string) => formatInZone(new Date(iso), { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  const sheets = healthReportSheets(diagnosis, read.events, actions, fmt);
  if (read.truncated) sheets[1].rows.push(['', '', '', 'Older entries left out: the report holds the newest ones.', '']);
  downloadWorkbook(buildWorkbook(sheets), `whiteroom-health-${days.toDay}.xlsx`);
  return null;
}
