import 'server-only';

/** Outgoing security links must not inherit attacker-controlled Host headers. */
export function appOrigin(): string {
  const url = new URL(process.env.AUTH_URL || 'https://app.whiteroom.tech');
  const local = process.env.NODE_ENV !== 'production' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
      url.username || url.password) {
    throw new Error('Invalid application origin configuration.');
  }
  return url.origin;
}
