import type { Metadata } from 'next';
import { FONT_DISPLAY } from '@whiteroom/ui';

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
    <div
      className="min-h-screen font-sans flex items-center justify-center px-7"
      style={{ background: '#070B14', color: '#EAF1FF' }}
    >
      <div className="w-full max-w-sm text-center space-y-8">
        <div>
          <h1 className="text-3xl font-display font-bold tracking-tight">
            {valid ? 'Confirm sign-in' : 'Something is missing'}
          </h1>
          <p className="text-sm mt-2" style={{ color: '#6B7C9E' }}>
            {valid ? (
              <>
                You&apos;re signing in as <span style={{ color: '#EAF1FF' }}>{email}</span>.
              </>
            ) : (
              'This link is incomplete. Request a new one to continue.'
            )}
          </p>
        </div>

        <div className="rounded-xl p-8 space-y-5" style={{ background: '#0A1020', border: '1px solid #1B2740' }}>
          {valid ? (
            <>
              <form method="POST" action={action}>
                <button
                  type="submit"
                  className="w-full rounded-lg px-6 py-3 text-sm font-semibold transition-colors cursor-pointer"
                  style={{ background: '#38E1FF', color: '#04222B', fontFamily: FONT_DISPLAY }}
                >
                  Sign in to WhiteRoom
                </button>
              </form>
              <p className="text-xs" style={{ color: '#6B7C9E' }}>
                This link can only be used once and expires 24 hours after it was sent.
              </p>
            </>
          ) : (
            <a
              href="/sign-in"
              className="inline-flex items-center justify-center w-full rounded-lg px-6 py-3 text-sm font-semibold"
              style={{ background: '#38E1FF', color: '#04222B', textDecoration: 'none', fontFamily: FONT_DISPLAY }}
            >
              Back to sign-in
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
