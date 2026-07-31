'use client';

import { createClient } from '@/lib/supabase/client';
import { posthog, initAnalytics } from '@/lib/analytics';
import { useState } from 'react';
import { BrandLink, FONT_DISPLAY } from '@whiteroom/ui';

export default function SignInPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [emailLoading, setEmailLoading] = useState(false);
  const [linkSent, setLinkSent] = useState(false);

  async function signInWithGoogle() {
    setLoading(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    if (error) {
      setError(error.message);
      setLoading(false);
    }
  }

  async function signInWithEmail(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setEmailLoading(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    setEmailLoading(false);
    if (error) {
      setError(error.message);
    } else {
      setLinkSent(true);
      initAnalytics();
      posthog.capture('magic_link_requested');
    }
  }

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
              Get started
            </h1>
            <p className="text-sm mt-2" style={{ color: '#6B7C9E' }}>
              Sign in to provision your fleet and get your API key.
            </p>
          </div>

          <div className="rounded-xl p-8 space-y-5" style={{ background: '#0A1020', border: '1px solid #1B2740' }}>
            {linkSent ? (
              <div className="space-y-3 py-2">
                <p className="text-sm font-semibold" style={{ color: '#38E1FF' }}>Check your inbox</p>
                <p className="text-sm" style={{ color: '#A9B8D4' }}>
                  We sent a sign-in link to <span style={{ color: '#EAF1FF' }}>{email}</span>.
                  Click it to finish signing in.
                </p>
                <button
                  onClick={() => setLinkSent(false)}
                  className="text-xs font-mono cursor-pointer bg-transparent border-0 underline"
                  style={{ color: '#6B7C9E' }}
                >
                  Use a different email
                </button>
              </div>
            ) : (
              <>
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

                <div className="flex items-center gap-3">
                  <div className="flex-1 h-px" style={{ background: '#1B2740' }} />
                  <span className="text-[10px] font-mono tracking-[.08em]" style={{ color: '#384766' }}>OR</span>
                  <div className="flex-1 h-px" style={{ background: '#1B2740' }} />
                </div>

                <form onSubmit={signInWithEmail} className="space-y-3">
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@company.com"
                    className="w-full rounded-lg px-4 py-3 text-sm outline-none"
                    style={{ background: '#070B14', border: '1px solid #1B2740', color: '#EAF1FF' }}
                  />
                  <button
                    type="submit"
                    disabled={emailLoading || !email.trim()}
                    className="w-full rounded-lg px-6 py-3 text-sm font-semibold transition-all cursor-pointer disabled:opacity-50"
                    style={{ background: '#38E1FF', color: '#04222B', fontFamily: FONT_DISPLAY }}
                  >
                    {emailLoading ? 'Sending link...' : 'Email me a sign-in link'}
                  </button>
                </form>
              </>
            )}
            {error && <p className="text-xs font-mono" style={{ color: '#FF6B7A' }}>{error}</p>}
          </div>

          <p className="text-[10px] font-mono tracking-[.08em]" style={{ color: '#384766' }}>
            Secure sign-in powered by Supabase
          </p>
        </div>
      </div>
    </div>
  );
}
