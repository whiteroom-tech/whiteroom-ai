'use client';

// The shared login card for the Citadel pages, driven by useFleetAuth. Render
// it whenever auth.status !== 'authenticated':
//
//   const auth = useFleetAuth();
//   if (auth.status !== 'authenticated') return <FleetLogin auth={auth} />;
//
// While the stored session is still being checked it renders only the page
// background, so the form never flashes for an already-signed-in user.

import { useState } from 'react';
import type { FleetAuthState } from '@/hooks/useFleetAuth';
import { Logo, FONT_DISPLAY, FONT_MONO } from '@whiteroom/ui';

export function FleetLogin({ auth }: { auth: FleetAuthState }) {
  const [loginToken, setLoginToken] = useState('');

  if (auth.status === 'checking') {
    return <div className="min-h-screen" style={{ background: 'var(--bg)' }} />;
  }

  async function handleFleetLogin(e: React.FormEvent) {
    e.preventDefault();
    await auth.login(loginToken);
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ background: 'var(--bg)', fontFamily: "'Inter', system-ui, sans-serif" }}>
      <div className="w-full max-w-md rounded-xl p-10 text-center" style={{ background: 'var(--card)', border: '1px solid var(--line)' }}>
        <div className="flex items-center justify-center gap-2.5 mb-1">
          <Logo width={22} height={30} gradientId="wr-l" />
          <span style={{ fontFamily: FONT_DISPLAY, fontSize: 26, fontWeight: 700, letterSpacing: 3, color: 'var(--tx)' }}>WHITE ROOM</span>
        </div>
        <p style={{ fontSize: 11.5, letterSpacing: 1, color: 'var(--tx3)', marginBottom: 32 }}>FLEET MONITORING DASHBOARD</p>

        {auth.retryableError && (
          <div className="text-left" style={{ background: 'var(--warn-bg)', border: '1px solid var(--warn)', borderRadius: 8, padding: '12px 16px', marginBottom: 24 }}>
            <p style={{ color: 'var(--warn)', fontSize: 14.5, margin: 0 }}>{auth.retryableError}</p>
            <button
              type="button"
              onClick={auth.retry}
              style={{ marginTop: 10, fontSize: 12.5, fontWeight: 700, letterSpacing: 1, fontFamily: FONT_DISPLAY, color: 'var(--tx)', border: '1px solid var(--line2)', borderRadius: 6, padding: '6px 14px', background: 'var(--card)', cursor: 'pointer' }}
            >
              RETRY
            </button>
          </div>
        )}

        <form onSubmit={handleFleetLogin} className="space-y-4 text-left">
          <div>
            <label htmlFor="fleet-token" style={{ display: 'block', fontSize: 11.5, color: 'var(--tx3)', marginBottom: 8, letterSpacing: 1, fontFamily: FONT_MONO }}>
              YOUR API KEY OR FLEET TOKEN
            </label>
            <input
              id="fleet-token"
              type="password"
              value={loginToken}
              onChange={(e) => setLoginToken(e.target.value)}
              placeholder="wr_... or sk-ant-..."
              required
              style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 8, padding: '12px 16px', color: 'var(--tx)', fontSize: 14.5, fontFamily: FONT_MONO, outline: 'none' }}
            />
          </div>

          {auth.loginError && (
            <p style={{ color: 'var(--bad)', fontSize: 14.5 }}>{auth.loginError}</p>
          )}

          <button
            type="submit"
            disabled={auth.loginLoading || !loginToken}
            style={{ width: '100%', background: 'var(--brand)', color: 'var(--bg)', borderRadius: 8, padding: '12px 0', fontWeight: 700, fontSize: 15, letterSpacing: 1, fontFamily: FONT_DISPLAY, border: 'none', cursor: auth.loginLoading || !loginToken ? 'not-allowed' : 'pointer', opacity: auth.loginLoading || !loginToken ? 0.4 : 1, transition: 'opacity .15s' }}
          >
            {auth.loginLoading ? 'CONNECTING...' : 'CONNECT TO MY FLEET →'}
          </button>
        </form>

        <p style={{ color: 'var(--tx3)', fontSize: 11.5, textAlign: 'center', marginTop: 24, lineHeight: 1.6 }}>
          Your key is never stored or sent to any third party.<br />
          It is used only to identify your fleet in this session.
        </p>
      </div>
    </div>
  );
}
