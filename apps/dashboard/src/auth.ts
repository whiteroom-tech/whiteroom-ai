import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google],
  session: { strategy: 'jwt' },
  // Required off Vercel — Cloud Run sits behind a proxy that sets
  // X-Forwarded-* headers rather than terminating TLS itself.
  trustHost: true,
  callbacks: {
    async jwt({ token, account }) {
      // Pin to Google's stable `sub` claim rather than NextAuth's
      // per-session token id, so it can key Postgres rows across sessions.
      if (account) token.sub = account.providerAccountId;
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.sub) session.user.id = token.sub;
      return session;
    },
  },
});
