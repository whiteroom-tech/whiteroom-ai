import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import Resend from 'next-auth/providers/resend';
import PostgresAdapter from '@auth/pg-adapter';
import { db } from '@/lib/db';

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
    }),
  ],
  // Sessions stay JWT even with an adapter: only the magic-link tokens need to
  // round-trip through Postgres, and this avoids a DB read on every request.
  session: { strategy: 'jwt' },
  // Required off Vercel — Cloud Run sits behind a proxy that sets
  // X-Forwarded-* headers rather than terminating TLS itself.
  trustHost: true,
  pages: { signIn: '/sign-in' },
  callbacks: {
    async session({ session, token }) {
      if (session.user && token.sub) session.user.id = token.sub;
      return session;
    },
  },
});
