/**
 * A value made safe to put inside a log line: line breaks are removed and other
 * control characters become spaces, so nothing outside the code can start a fake log
 * entry, and it's capped so one value can't flood the log. For ids, paths and
 * short reasons; never for secrets, which don't go in logs at all.
 */
export function logSafe(value: unknown, max = 200): string {
  // Line breaks are removed with the exact pattern CodeQL recognises as a
  // log-injection sanitizer; other C0/C1 controls, DEL and the Unicode line
  // and paragraph separators become spaces.
  const oneLine = String(value).replace(/\n|\r/g, '');
  return oneLine.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').slice(0, max);
}
