import type { Metadata } from 'next';
import { FONT_DISPLAY } from '@whiteroom/ui';
import { ThemedShell } from '@/components/ThemedShell';

export const metadata: Metadata = {
  title: 'Confirm sign-in',
  // The URL carries a live verification token, so keep it out of search
  // indexes and out of the Referer header sent to the font CDN in the layout.
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

// The interstitial that makes magic links survive email link scanners.
//
// Rendering this page is a pure GET with no side effects — a scanner that
// fetches the emailed URL gets this markup and nothing is consumed. Only the
// form POST below reaches /api/auth/callback/resend, where Auth.js redeems the
// token. Auth.js reads token/email/callbackUrl off the query string regardless
// of method, and enforces CSRF on callbacks for credentials providers only, so
// posting the params in the action URL with an empty body is all that's needed.
export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

  const token = one(params.token);
  const email = one(params.email);
  const callbackUrl = one(params.callbackUrl) || '/dashboard';

  const valid = Boolean(token && email);

  const action = valid
    ? `/api/auth/callback/resend?${new URLSearchParams({ token: token!, email: email!, callbackUrl })}`
    : undefined;

  return (
    <ThemedShell className="min-h-screen font-sans flex items-center justify-center px-7">
      <div className="w-full max-w-sm text-center space-y-8">
        <div>
          <h1 className="text-3xl font-display font-bold tracking-tight">
            {valid ? 'Confirm sign-in' : 'Something is missing'}
          </h1>
          <p className="text-sm mt-2" style={{ color: 'var(--tx2)' }}>
            {valid ? (
              <>
                You&apos;re signing in as <span style={{ color: 'var(--tx)' }}>{email}</span>.
              </>
            ) : (
              'This link is incomplete. Request a new one to continue.'
            )}
          </p>
        </div>

        <div className="rounded-xl p-8 space-y-5" style={{ background: 'var(--card)', border: '1px solid var(--line)' }}>
          {valid ? (
            <>
              <form method="POST" action={action}>
                <button
                  type="submit"
                  className="w-full rounded-lg px-6 py-3 text-sm font-semibold transition-colors cursor-pointer"
                  style={{ background: 'var(--brand)', color: 'var(--on-brand)', fontFamily: FONT_DISPLAY }}
                >
                  Sign in to WhiteRoom
                </button>
              </form>
              <p className="text-xs" style={{ color: 'var(--tx2)' }}>
                This link can only be used once and expires 24 hours after it was sent.
              </p>
            </>
          ) : (
            <a
              href="/sign-in"
              className="inline-flex items-center justify-center w-full rounded-lg px-6 py-3 text-sm font-semibold"
              style={{ background: 'var(--brand)', color: 'var(--on-brand)', textDecoration: 'none', fontFamily: FONT_DISPLAY }}
            >
              Back to sign-in
            </a>
          )}
        </div>
      </div>
    </ThemedShell>
  );
}
