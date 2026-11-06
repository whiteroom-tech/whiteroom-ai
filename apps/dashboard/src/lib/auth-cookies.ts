/**
 * Cookie options for Auth.js across app / admin / console hosts.
 *
 * Google OAuth always callbacks to AUTH_URL (app.whiteroom.tech) because Cloud
 * Run without AUTH_URL emits redirect_uri=https://0.0.0.0:8080/…. CSRF, PKCE
 * and session cookies must therefore be readable on every *.whiteroom.tech
 * host — otherwise sign-in started on admin. fails the check on app. and
 * lands on "temporarily unavailable".
 *
 * Set AUTH_COOKIE_DOMAIN=.whiteroom.tech in production. Leave unset locally.
 *
 * The CSRF cookie cannot keep Auth.js's default `__Host-` name. That prefix
 * forbids a Domain attribute, so browsers drop the cookie and the Google
 * callback on app. fails with MissingCSRF — which sends the user to the
 * customer app instead of back to admin. or console.
 *
 * AUTH_COOKIE_PREFIX renames every Auth.js cookie (default "authjs", Auth.js's
 * own names). The EU deployment sets its own prefix: the US cookies carry
 * Domain=.whiteroom.tech, so browsers also send them to eu.*.whiteroom.tech,
 * and with the same names the EU dashboard couldn't tell its cookies apart.
 */

const secure = process.env.NODE_ENV === 'production';

function cookieDomain(): string | undefined {
  const raw = process.env.AUTH_COOKIE_DOMAIN?.trim();
  if (!raw) return undefined;
  // Leading dot is conventional for subdomain sharing.
  return raw.startsWith('.') ? raw : `.${raw}`;
}

/** Shared options applied to every Auth.js cookie we configure. */
export function authCookieOptions(): {
  httpOnly: boolean;
  sameSite: 'lax';
  path: string;
  secure: boolean;
  domain?: string;
} {
  const domain = cookieDomain();
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure,
    ...(domain ? { domain } : {}),
  };
}

// Letters, digits, _ and - only: anything else could break the Set-Cookie
// header (;, =, spaces) or double the __Secure-/__Host- prefix we add.
const VALID_PREFIX = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
let warnedBadPrefix = false;

function cookiePrefix(): string {
  const raw = process.env.AUTH_COOKIE_PREFIX?.trim();
  if (!raw) return 'authjs';
  if (VALID_PREFIX.test(raw)) return raw;
  if (!warnedBadPrefix) {
    warnedBadPrefix = true;
    console.warn('[auth] AUTH_COOKIE_PREFIX may only use letters, digits, _ and -; using "authjs".');
  }
  return 'authjs';
}

/** `__Secure-` (not `__Host-`) so Domain=AUTH_COOKIE_DOMAIN is legal. */
function cookieName(suffix: string, useSecure = secure): string {
  return `${useSecure ? '__Secure-' : ''}${cookiePrefix()}.${suffix}`;
}

export function sessionCookieName(useSecure = secure): string {
  return cookieName('session-token', useSecure);
}

/** Pass `useSecure` in tests; production follows NODE_ENV. */
export function csrfCookieName(useSecure = secure): string {
  return cookieName('csrf-token', useSecure);
}

/** The other Auth.js cookies, under the same prefix as the session and CSRF ones. */
export function flowCookieNames(useSecure = secure): { callbackUrl: string; pkceCodeVerifier: string; state: string; nonce: string } {
  return {
    callbackUrl: cookieName('callback-url', useSecure),
    pkceCodeVerifier: cookieName('pkce.code_verifier', useSecure),
    state: cookieName('state', useSecure),
    nonce: cookieName('nonce', useSecure),
  };
}
