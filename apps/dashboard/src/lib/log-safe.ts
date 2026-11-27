/**
 * A value made safe to put inside a log line: line breaks and other control
 * characters become spaces, so nothing outside the code can start a fake log
 * entry, and it's capped so one value can't flood the log. For ids, paths and
 * short reasons; never for secrets, which don't go in logs at all.
 */
export function logSafe(value: unknown, max = 200): string {
  return String(value).replace(/\r|\n/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
}
