import type { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      /**
       * Presentation only — it decides whether the Admin nav item renders.
       * Authorisation always goes through requireAdmin() in lib/admin.ts,
       * which re-reads the database, because this copy can be up to
       * SESSION_REVALIDATE_SECONDS behind a revoked role.
       */
      role: string;
    } & DefaultSession['user'];
  }
}

// Augments '@auth/core/jwt', NOT 'next-auth/jwt'.
//
// next-auth/jwt.d.ts is a bare `export * from "@auth/core/jwt"`, so declaring a
// module of that name creates a second, unrelated module rather than merging
// into the real JWT interface. The claims below would silently stay `unknown`
// — which typechecks anywhere a `typeof` guard narrows them, so the mistake
// hides until the first line that uses one without a guard.
declare module '@auth/core/jwt' {
  interface JWT {
    // Set once when the session is created and never refreshed, unlike the
    // standard `iat`. See the jwt callback in auth.ts — global sign-out
    // compares against this, and a moving claim would defeat it.
    sessionStart?: number;
    // Unix seconds of the last users.sessions_valid_after lookup, used to
    // throttle that read to once per SESSION_REVALIDATE_SECONDS.
    revalidatedAt?: number;
    role?: string;
  }
}
