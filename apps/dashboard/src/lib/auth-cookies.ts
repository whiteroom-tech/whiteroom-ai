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

export function sessionCookieName(): string {
  return secure ? '__Secure-authjs.session-token' : 'authjs.session-token';
}

/**
 * `__Secure-` (not `__Host-`) so Domain=AUTH_COOKIE_DOMAIN is legal.
 * Pass `useSecure` in tests; production follows NODE_ENV.
 */
export function csrfCookieName(useSecure = secure): string {
  return useSecure ? '__Secure-authjs.csrf-token' : 'authjs.csrf-token';
}
