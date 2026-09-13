import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import Resend from 'next-auth/providers/resend';
import PostgresAdapter from '@auth/pg-adapter';
import { db } from '@/lib/db';
import { magicLinkEmail } from '@/lib/magic-link-email';

// How long a token may go without being re-checked against
// users.sessions_valid_after. Also the upper bound on how long a revoked
// session stays usable — shorten it to revoke faster at the cost of more
// single-row lookups.
const SESSION_REVALIDATE_SECONDS = 5 * 60;

/**
 * Reads a user's role at sign-in, so the first page render already knows
 * whether to draw the Admin link instead of waiting out the first
 * revalidation. Never used to authorise anything — see the jwt callback.
 */
async function readRole(userId: string | undefined): Promise<string> {
  if (!userId) return 'user';
  try {
    const { rows } = await db().query(`SELECT role FROM users WHERE id = $1`, [userId]);
    return rows[0]?.role ?? 'user';
  } catch {
    return 'user';
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  // The adapter is what makes email sign-in possible at all: magic links need
  // their one-time tokens persisted server-side (verification_token), which a
  // pure-JWT setup has nowhere to put. It also owns users/accounts, so the
  // user id in a session is now the users.id the adapter issued rather than
  // the raw Google `sub` — see migrations/001_nextauth.sql for the backfill
  // that keeps pre-adapter rows attached to their Google account.
  adapter: PostgresAdapter(db()),
  providers: [
    Google,
    Resend({
      apiKey: process.env.AUTH_RESEND_KEY,
      from: process.env.AUTH_EMAIL_FROM || 'WhiteRoom <no-reply@whiteroom.tech>',
      // Auth.js consumes the verification token on the *GET* of
      // /api/auth/callback/resend, so whoever fetches that URL first wins —
      // and Gmail's link scanner fetches it on delivery, from Google IPs with
      // a Windows Chrome UA. When the scanner wins the race the human's click
      // dead-ends on `Verification` and the link can never be redeemed.
      //
      // So the email points at /auth/verify instead: a page whose GET is inert
      // and whose button POSTs to the real callback. Scanners issue GETs, so
      // the token survives until a person actually clicks.
      async sendVerificationRequest({ identifier: to, provider, url }) {
        const callback = new URL(url);
        const confirmUrl = new URL('/auth/verify', callback.origin);
        confirmUrl.search = callback.search;

        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${provider.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: provider.from,
            to,
            subject: 'Sign in to WhiteRoom',
            ...magicLinkEmail(confirmUrl.toString()),
          }),
        });

        if (!res.ok) {
          throw new Error('Resend error: ' + JSON.stringify(await res.json()));
        }
      },
    }),
  ],
  // Sessions stay JWT even with an adapter: only the magic-link tokens need to
  // round-trip through Postgres, and this avoids a DB read on every request.
  // Trade-off for revocation, see the jwt callback: a JWT session is only as
  // revocable as it is short-lived, so cap it at a week rather than the
  // 30-day default. Tokens are re-checked against the database every
  // SESSION_REVALIDATE_SECONDS anyway; this bounds the worst case if that
  // check is ever bypassed.
  session: { strategy: 'jwt', maxAge: 7 * 24 * 60 * 60 },
  // Required off Vercel — Cloud Run sits behind a proxy that sets
  // X-Forwarded-* headers rather than terminating TLS itself.
  trustHost: true,
  // Without an error page, every failure lands on Auth.js's built-in one at
  // /api/auth/error, served as a bare 403 with no way back into the flow.
  // /sign-in reads ?error= and offers a new link instead.
  pages: { signIn: '/sign-in', error: '/sign-in' },
  callbacks: {
    // Global sign-out for JWT sessions.
    //
    // There are no session rows to delete (strategy: 'jwt'), so "sign out
    // everywhere" can't work by revoking records — it works by stamping
    // users.sessions_valid_after and rejecting every token issued before it.
    //
    // Two details make that actually hold:
    //
    // 1. The comparison uses `sessionStart`, set once when the session is
    //    created and never touched again — NOT the standard `iat`, which
    //    Auth.js refreshes each time it re-encodes the cookie. Comparing
    //    against a claim that keeps moving forward would let a live session
    //    outrun the revocation stamp and never be signed out.
    //
    // 2. A token with no `sessionStart` is rejected outright rather than
    //    grandfathered. Sessions minted before this callback shipped have no
    //    such claim, and adopting them would mean silently trusting exactly
    //    the tokens whose age we can't establish. The cost is one forced
    //    re-authentication at deploy; the alternative is a revocation feature
    //    with a documented bypass.
    //
    // The database read is throttled to once per SESSION_REVALIDATE_SECONDS
    // per token, which is what keeps this from reintroducing the per-request
    // query that choosing JWT sessions avoided. Revocation is therefore
    // effective within that window rather than instantly.
    async jwt({ token, user }) {
      const now = Math.floor(Date.now() / 1000);

      if (user) {
        token.sessionStart = now;
        token.revalidatedAt = now;
        token.role = await readRole(user.id);
        return token;
      }

      if (typeof token.sessionStart !== 'number') return null;

      const lastCheck = typeof token.revalidatedAt === 'number' ? token.revalidatedAt : 0;
      if (now - lastCheck < SESSION_REVALIDATE_SECONDS) return token;

      if (!token.sub) return null;

      try {
        const { rows } = await db().query(
          `SELECT sessions_valid_after, role FROM users WHERE id = $1`,
          [token.sub],
        );
        // No row means the account was deleted while this token was still
        // live — the session has to go with it.
        if (rows.length === 0) return null;

        const validAfter: Date | null = rows[0].sessions_valid_after;
        if (validAfter && token.sessionStart * 1000 <= validAfter.getTime()) return null;

        // Rides along on the query that was already happening. This copy of
        // the role decides one thing only — whether the Admin link is drawn —
        // so it being up to SESSION_REVALIDATE_SECONDS stale is fine. Nothing
        // is authorised from it: requireAdmin() re-reads the database on every
        // admin request precisely because this value can lag a revocation.
        token.role = rows[0].role ?? 'user';
        token.revalidatedAt = now;
        return token;
      } catch {
        // A database blip shouldn't sign the whole product out. Keep the
        // session and leave revalidatedAt untouched so the next request
        // retries immediately rather than waiting out the throttle.
        return token;
      }
    },
    async session({ session, token }) {
      if (session.user && token.sub) {
        session.user.id = token.sub;
        session.user.role = token.role ?? 'user';
      }
      return session;
    },
  },
});
