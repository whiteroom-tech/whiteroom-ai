// How a session signed in, and whether that's good enough for the admin role.
//
// SOC 2 control ID-01 (spec v3.3 item D-1): admin actions need a sign-in that
// proves two-step verification. A Google sign-in on the company Workspace
// domain does, because the domain enforces it; an email link or a consumer
// Google account doesn't.
//
// The method is recorded once, at sign-in, in the JWT. Enforcement is off
// until ADMIN_SIGN_IN_DOMAIN is set, so a deploy can't lock out an admin who
// hasn't yet signed in with a Workspace account.

/** Recorded at sign-in: 'google:<workspace domain>', 'google', or 'email'. */
export function signInMethod(
  account: { provider?: string } | null | undefined,
  profile: { hd?: unknown; email_verified?: unknown } | null | undefined,
): string {
  if (account?.provider !== 'google') return 'email';
  // `hd` is set by Google only for Workspace accounts. Ignore it unless the
  // address is verified, so the claim can't come from an unverified alias.
  const hd = typeof profile?.hd === 'string' ? profile.hd.toLowerCase() : '';
  return hd && profile?.email_verified === true ? `google:${hd}` : 'google';
}

/**
 * True when this session may use the admin role. With no domain configured
 * every sign-in method is allowed (enforcement off); with one, only a Google
 * sign-in on that Workspace domain is.
 */
export function adminSignInAllowed(
  method: string | undefined,
  domain: string | undefined = process.env.ADMIN_SIGN_IN_DOMAIN,
): boolean {
  const want = domain?.trim().toLowerCase();
  if (!want) return true;
  return method === `google:${want}`;
}
