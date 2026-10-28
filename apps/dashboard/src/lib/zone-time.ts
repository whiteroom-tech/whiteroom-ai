// The viewer's time zone, and calendar maths in it.
//
// Settings › Profile › Time zone saves a zone on the account (null = "use my
// browser's time zone"). Providers sets it here from the signed-in account as
// the page loads, and Settings sets it again the moment a new zone is saved,
// so every day, hour and clock time the dashboard shows (and the `tz` it
// sends the engine) is in that one zone. With nothing saved it's the
// browser's zone, as before.
//
// Days are "YYYY-MM-DD" keys in that zone. Everything goes through Intl with
// an explicit timeZone, never Date's local getters, so the browser's (or a
// test runner's) own zone never leaks in.

let saved: string | null = null;

/** True when this runtime's Intl knows `tz` (Node and browsers ship different zone databases). */
export function isKnownZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The browser's own zone; '' when it doesn't name one (dates then use the runtime's default zone). */
export function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

/** Use `tz` for every date from now on; null (or a zone this browser doesn't know) means the browser's zone. */
export function setViewerZone(tz: string | null | undefined): void {
  saved = tz && isKnownZone(tz) ? tz : null;
}

/** The zone saved on the account, or null when dates follow the browser. */
export function savedViewerZone(): string | null {
  return saved;
}

/** The zone the dashboard shows dates in: the saved one, else the browser's ('' = the runtime's default). */
export function viewerZone(): string {
  return saved ?? browserZone();
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** A cached formatter for `opts` in `tz`. */
function formatter(tz: string, opts: Intl.DateTimeFormatOptions, locale = 'en-US'): Intl.DateTimeFormat {
  const key = `${locale}|${tz}|${JSON.stringify(opts)}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { ...opts, timeZone: tz || undefined });
    formatters.set(key, f);
  }
  return f;
}

const PARTS: Intl.DateTimeFormatOptions = {
  hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
};

export interface ZonedParts { year: number; month: number; day: number; hour: number; minute: number; second: number }

/** The wall-clock reading of instant `ms` in `tz` (month 1–12). */
export function zonedParts(ms: number, tz: string = viewerZone()): ZonedParts {
  // An unreadable time reads as NaN everywhere (as Date's getters did) rather than throwing.
  if (!Number.isFinite(ms)) return { year: NaN, month: NaN, day: NaN, hour: NaN, minute: NaN, second: NaN };
  const p: Record<string, number> = {};
  for (const { type, value } of formatter(tz, PARTS).formatToParts(new Date(ms))) {
    if (type !== 'literal') p[type] = Number(value);
  }
  // Some ICU builds write midnight as "24" even with h23.
  return { year: p.year, month: p.month, day: p.day, hour: p.hour % 24, minute: p.minute, second: p.second };
}

/** Minutes `tz` is ahead of UTC at instant `ms` (−240 for New York in summer, 330 for India). */
export function offsetMinutes(ms: number, tz: string = viewerZone()): number {
  const p = zonedParts(ms, tz);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((wall - Math.floor(ms / 1000) * 1000) / 60_000);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "2026-10-28": the day in `tz` that holds instant `ms`. */
export function dayKey(ms: number = Date.now(), tz: string = viewerZone()): string {
  const p = zonedParts(ms, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** The hour (0–23) on the clock in `tz` at instant `ms`. */
export function hourOf(ms: number, tz: string = viewerZone()): number {
  return zonedParts(ms, tz).hour;
}

/** "14:05:09" on the clock in `tz` at instant `ms`. */
export function clockOf(ms: number, tz: string = viewerZone()): string {
  const p = zonedParts(ms, tz);
  return `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/** The calendar day `n` days after `day` (negative for before). Pure calendar maths, so no zone or DST can skip a day. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Whole calendar days from `a` to `b` (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * The first instant of `day` in `tz`. Normally its midnight; on a day whose
 * midnight a daylight-saving jump skips (Santiago, Havana), the moment the
 * clocks jump; when midnight happens twice, the first one.
 */
export function startOfDay(day: string, tz: string = viewerZone()): number {
  const [y, m, d] = day.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d);
  // Local midnight is within 14 hours of UTC midnight, so its offset is one of these.
  const candidates = [wall - 14 * 3_600_000, wall, wall + 14 * 3_600_000]
    .map((t) => wall - offsetMinutes(t, tz) * 60_000)
    .filter((t) => dayKey(t, tz) === day)
    .sort((a, b) => a - b);
  const exact = candidates.find((t) => { const p = zonedParts(t, tz); return p.hour === 0 && p.minute === 0; });
  return exact ?? candidates[0] ?? wall;
}

/** "-05:00": `tz`'s UTC offset at instant `ms`, so an export's times are unambiguous in a fall-back hour. */
export function offsetLabel(ms: number, tz: string = viewerZone()): string {
  const m = offsetMinutes(ms, tz);
  const a = Math.abs(m);
  return `${m < 0 ? '-' : '+'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** "EDT", or "GMT+5:30" where the zone has no short name; `style` 'long' gives "Eastern Daylight Time". */
export function zoneAbbr(ms: number = Date.now(), tz: string = viewerZone(), style: 'short' | 'long' = 'short'): string {
  if (!Number.isFinite(ms)) return 'local time';
  const part = formatter(tz, { timeZoneName: style }).formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName');
  return part?.value ?? 'local time';
}

/** `ts` formatted with `opts` in the viewer's zone (en-US unless `locale` says otherwise); '' for an unreadable time. */
export function formatInZone(ts: string | number | Date, opts: Intl.DateTimeFormatOptions, locale?: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : formatter(viewerZone(), opts, locale).format(d);
}

/** A "YYYY-MM-DD" day formatted with `opts` ("Tue", "Oct 28"): the same text in every zone. */
export function formatDayKey(day: string, opts: Intl.DateTimeFormatOptions, locale?: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return formatter('UTC', opts, locale).format(new Date(Date.UTC(y, m - 1, d, 12)));
}
