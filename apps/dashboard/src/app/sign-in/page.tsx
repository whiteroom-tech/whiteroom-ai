'use client';

import { signIn } from 'next-auth/react';
import { useEffect, useRef, useState } from 'react';
import { BrandLink, FONT_DISPLAY } from '@whiteroom/ui';
import { DEFAULT_DESTINATION, safeCallbackUrl } from '@/lib/callback-url';

type Method = 'google' | 'email';

/**
 * Which method this browser signed in with last.
 *
 * Both providers are passwordless, so signing up and signing in are the same
 * operation — a new address creates the account, a known one resumes it. The
 * only thing a returning user actually loses is which of the two they picked,
 * and getting that wrong is precisely what produces OAuthAccountNotLinked.
 * Remembering it here is what makes one card serve both cases honestly.
 */
const LAST_METHOD_KEY = 'wr_last_method';
const LAST_EMAIL_KEY = 'wr_last_email';

/**
 * Where this sign-in should land.
 *
 * Read at the moment of the click rather than held in state, so it cannot be
 * stale and cannot be missing because an effect had not run yet.
 *
 * Almost always /dashboard. The exception is the admin host, which serves the
 * panel and nothing else: /dashboard 404s there, so the admin gate sends
 * people here with ?callbackUrl=/admin and this is what honours it.
 * safeCallbackUrl() is what keeps that from being an open redirect.
 */
function destination(): string {
  const raw = new URLSearchParams(window.location.search).get('callbackUrl');
  return safeCallbackUrl(raw, DEFAULT_DESTINATION);
}

/** What to suggest when the method someone just tried turns out to be the wrong one. */
const OTHER_METHOD: Record<Method, string> = {
  google: 'the email sign-in link',
  email: 'Continue with Google',
};

const ERRORS: Record<string, string> = {
  Verification: 'That sign-in link has expired or was already used. Enter your email to get a new one.',
  OAuthAccountNotLinked: 'That email is already registered with a different sign-in method. Use the one you signed up with.',
  AccessDenied: 'That account is not allowed to sign in.',
  Configuration: 'Sign-in is temporarily unavailable. Please try again shortly.',
  Default: 'Something went wrong signing you in. Please try again.',
};

// Outcomes that land here deliberately, rather than failures. Settings
// redirects to /sign-in after ending a session or deleting an account, and
// without these the page would just look like an ordinary sign-out.
const OUTCOMES: Record<string, string> = {
  'signedOut=all': 'Signed out on every device. Sign in again to continue.',
  'deleted=1': 'Your account has been deleted.',
};

// localStorage throws outright in some privacy modes rather than returning
// null. Remembering the last method is a convenience; it must never be the
// reason someone can't sign in.
function readStore(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStore(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — the hint is simply not shown next time */
  }
}

function clearStore(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* as above */
  }
}

export default function SignInPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [emailLoading, setEmailLoading] = useState(false);
  const [linkSent, setLinkSent] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastMethod, setLastMethod] = useState<Method | null>(null);
  const [returning, setReturning] = useState(false);
  const consumedParams = useRef(false);

  // auth.ts points `pages.error` here, so a failed magic link arrives as
  // /sign-in?error=Verification rather than dead-ending on Auth.js's built-in
  // 403 page. Read it off the URL directly: useSearchParams would force this
  // page behind a Suspense boundary for no benefit. The param is stripped
  // afterwards so the warning doesn't outlive the attempt it describes.
  //
  // The remembered method is read here too rather than during render: the
  // server has no localStorage, so touching it any earlier is a hydration
  // mismatch. The page therefore opens on the neutral framing and settles
  // into "Welcome back" a frame later, the same way the notice banner does.
  //
  // Guarded to run exactly once. This effect reads one-shot URL parameters and
  // then destroys them, so it is not safe to run twice — and React StrictMode
  // (on by default in dev) invokes it twice on purpose. The second pass sees
  // the already-stripped URL, concludes nobody was signed out, and resets
  // `returning` to false. A conditional setState would paper over it; a guard
  // says what is actually true, which is that consuming a param is a
  // one-time act.
  useEffect(() => {
    if (consumedParams.current) return;
    consumedParams.current = true;

    const params = new URLSearchParams(window.location.search);
    const url = new URL(window.location.href);

    const stored = readStore(LAST_METHOD_KEY);
    let remembered: Method | null = stored === 'google' || stored === 'email' ? stored : null;
    let wasSignedOut = false;

    const code = params.get('error');
    if (code) {
      if (code === 'OAuthAccountNotLinked' && remembered) {
        // A sign-in that worked would have landed on its destination, so
        // arriving back here means the remembered method just failed —
        // which makes the other one the answer. Cleared afterwards so a stale
        // "you last used X" can't outlive the attempt that disproved it.
        setNotice(
          `That email is already registered with a different sign-in method. Try ${OTHER_METHOD[remembered]} instead.`,
        );
        clearStore(LAST_METHOD_KEY);
        remembered = null;
      } else {
        setNotice(ERRORS[code] ?? ERRORS.Default);
      }
      url.searchParams.delete('error');
    } else {
      for (const [key, message] of Object.entries(OUTCOMES)) {
        const [name, value] = key.split('=');
        if (params.get(name) !== value) continue;
        setNotice(message);
        if (name === 'deleted') {
          // The opposite of a returning user: the account this pointed at is
          // gone, and greeting them with "Welcome back" over the top of
          // "Your account has been deleted" would be absurd.
          clearStore(LAST_METHOD_KEY);
          clearStore(LAST_EMAIL_KEY);
          remembered = null;
        } else {
          wasSignedOut = true;
        }
        url.searchParams.delete(name);
        break;
      }
    }

    setLastMethod(remembered);
    setReturning(remembered !== null || wasSignedOut);

    const rememberedEmail = readStore(LAST_EMAIL_KEY);
    if (remembered === 'email' && rememberedEmail) setEmail(rememberedEmail);

    if (url.search !== window.location.search) {
      window.history.replaceState(null, '', url.pathname + url.search);
    }
  }, []);

  async function signInWithGoogle() {
    setLoading(true);
    setError(null);
    setNotice(null);
    // Recorded before the redirect rather than after success, because there is
    // no "after" on this page — a working Google sign-in never comes back.
    // The effect above is what reinterprets this value if it does.
    writeStore(LAST_METHOD_KEY, 'google');
    try {
      await signIn('google', { callbackUrl: destination() });
    } catch {
      setError('Could not start sign-in. Please try again.');
      setLoading(false);
    }
  }

  async function signInWithEmail(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setEmailLoading(true);
    setError(null);
    setNotice(null);
    // redirect:false so the "check your inbox" state renders here rather than
    // bouncing through Auth.js's default verify-request page.
    const res = await signIn('resend', {
      email: email.trim(),
      callbackUrl: destination(),
      redirect: false,
    });
    setEmailLoading(false);
    if (res?.error) {
      setError('Could not send the sign-in link. Please try again.');
    } else {
      // Unlike Google, this path has a real success to observe, so it records
      // one rather than an attempt.
      writeStore(LAST_METHOD_KEY, 'email');
      writeStore(LAST_EMAIL_KEY, email.trim());
      setLinkSent(true);
    }
  }

  const heading = returning ? 'Welcome back' : 'Sign in to WhiteRoom';
  const subheading = returning
    ? 'Sign in to pick up where you left off.'
    : 'New here? Signing in creates your account and provisions your fleet.';

  return (
    <div className="min-h-screen font-sans flex flex-col" style={{ background: '#070B14', color: '#EAF1FF' }}>
      {/* Header — matches whiteroom.tech */}
      <header className="sticky top-0 z-50" style={{ background: 'rgba(7,11,20,.74)', backdropFilter: 'blur(16px)', borderBottom: '1px solid #15203A' }}>
        <nav className="max-w-[1200px] mx-auto flex items-center justify-between h-[66px] px-7">
          <BrandLink />
          <div className="flex items-center gap-6">
            <a href="https://whiteroom.tech/#how" className="text-sm transition-colors hover:text-[#EAF1FF]" style={{ color: '#A9B8D4', textDecoration: 'none' }}>How it works</a>
            <a href="https://whiteroom.tech/#why" className="text-sm transition-colors hover:text-[#EAF1FF]" style={{ color: '#A9B8D4', textDecoration: 'none' }}>Why it matters</a>
            <a href="https://whiteroom.tech/#pricing" className="text-sm transition-colors hover:text-[#EAF1FF]" style={{ color: '#A9B8D4', textDecoration: 'none' }}>Pricing</a>
            <a href="https://whiteroom.tech/docs.html" className="inline-flex items-center justify-center h-[38px] px-5 rounded-lg text-sm font-semibold transition-all" style={{ border: '1px solid #1B2740', color: '#EAF1FF', textDecoration: 'none', fontFamily: FONT_DISPLAY }}>Docs</a>
            <a href="https://whiteroom.tech/docs.html" className="inline-flex items-center justify-center h-[38px] px-5 rounded-lg text-sm font-semibold transition-all" style={{ background: '#38E1FF', color: '#04222B', textDecoration: 'none', fontFamily: FONT_DISPLAY }}>Try it instantly</a>
          </div>
        </nav>
      </header>

      {/* Sign-in card */}
      <div className="flex-1 flex items-center justify-center px-7">
        <div className="text-center space-y-8 w-full max-w-sm">
          <div>
            <h1 className="text-3xl font-display font-bold tracking-tight">
              {heading}
            </h1>
            <p className="text-sm mt-2" style={{ color: '#6B7C9E' }}>
              {subheading}
            </p>
          </div>

          <div className="rounded-xl p-8 space-y-5" style={{ background: '#0A1020', border: '1px solid #1B2740' }}>
            {notice && (
              <p
                className="rounded-lg px-4 py-3 text-xs text-left"
                style={{ background: 'rgba(255,107,122,.08)', border: '1px solid rgba(255,107,122,.35)', color: '#FF6B7A' }}
              >
                {notice}
              </p>
            )}

            <button
              onClick={signInWithGoogle}
              disabled={loading}
              className="flex items-center justify-center gap-3 w-full rounded-lg bg-white px-6 py-3 text-sm font-semibold text-gray-900 hover:bg-gray-50 transition-colors cursor-pointer disabled:opacity-50"
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              {loading ? 'Redirecting...' : 'Continue with Google'}
            </button>

            {linkSent ? (
              <div className="space-y-2 text-center">
                <p className="text-sm font-semibold">Check your inbox</p>
                <p className="text-xs" style={{ color: '#6B7C9E' }}>
                  We sent a sign-in link to <span style={{ color: '#EAF1FF' }}>{email.trim()}</span>. It expires in 24 hours.
                </p>
                <button
                  onClick={() => { setLinkSent(false); setError(null); setEmail(''); }}
                  className="text-xs underline cursor-pointer"
                  style={{ color: '#6B7C9E' }}
                >
                  Use a different email
                </button>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-3">
                  <div className="h-px flex-1" style={{ background: '#1B2740' }} />
                  <span className="text-xs" style={{ color: '#6B7C9E' }}>or</span>
                  <div className="h-px flex-1" style={{ background: '#1B2740' }} />
                </div>

                <form onSubmit={signInWithEmail} className="space-y-3">
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@company.com"
                    autoComplete="email"
                    className="w-full rounded-lg px-4 py-3 text-sm outline-none"
                    style={{ background: '#070B14', border: '1px solid #1B2740', color: '#EAF1FF' }}
                  />
                  <button
                    type="submit"
                    disabled={emailLoading || !email.trim()}
                    className="w-full rounded-lg px-6 py-3 text-sm font-semibold transition-colors cursor-pointer disabled:opacity-50"
                    style={{ background: '#38E1FF', color: '#04222B', fontFamily: FONT_DISPLAY }}
                  >
                    {emailLoading ? 'Sending...' : 'Email me a sign-in link'}
                  </button>
                </form>
              </>
            )}

            {error && <p className="text-xs font-mono" style={{ color: '#FF6B7A' }}>{error}</p>}
          </div>

          {/* The one thing a returning passwordless user can actually get
              wrong. Hidden once a link is on its way, when the instruction
              that matters is "check your inbox". */}
          {lastMethod && !linkSent && (
            <p className="text-xs" style={{ color: '#6B7C9E' }}>
              {lastMethod === 'google'
                ? 'You last signed in with Google.'
                : 'You last signed in with an email link.'}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
