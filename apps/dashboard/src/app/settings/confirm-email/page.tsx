import Link from 'next/link';
import { confirmEmailChange } from '@/lib/account';
import { ConfirmButton } from './confirm-button';

export const dynamic = 'force-dynamic';

/**
 * Lands the confirmation link from an email-change request.
 *
 * The GET is inert and the redemption happens on a POST from the button, for
 * exactly the reason auth.ts routes magic links through /auth/verify: mail
 * scanners fetch every URL in a message on delivery, and a token consumed by
 * a GET is consumed by the scanner before the person ever clicks.
 */
export default async function ConfirmEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; done?: string; error?: string }>;
}) {
  const params = await searchParams;

  if (params.done) {
    return (
      <Shell heading="Email updated">
        <p style={text}>
          Your account now signs in as <strong style={{ color: '#EAF1FF' }}>{params.done}</strong>. Every
          existing session was signed out, so you&apos;ll need to sign in again with the new address.
        </p>
        <Link href="/sign-in" style={linkButton}>Go to sign-in</Link>
      </Shell>
    );
  }

  if (params.error) {
    return (
      <Shell heading="Couldn't confirm that">
        <p style={text}>{params.error}</p>
        <Link href="/settings" style={linkButton}>Back to settings</Link>
      </Shell>
    );
  }

  if (!params.token) {
    return (
      <Shell heading="Link is incomplete">
        <p style={text}>This confirmation link is missing its token. Request a new one from Settings.</p>
        <Link href="/settings" style={linkButton}>Back to settings</Link>
      </Shell>
    );
  }

  async function confirm(token: string): Promise<{ ok: boolean; newEmail?: string; error?: string }> {
    'use server';
    const res = await confirmEmailChange(token);
    return res.ok ? { ok: true, newEmail: res.newEmail } : { ok: false, error: res.error };
  }

  return (
    <Shell heading="Confirm your new email">
      <p style={text}>
        Clicking below moves your WhiteRoom account to this address. You&apos;ll be signed out everywhere
        and will sign in with the new address from then on.
      </p>
      <ConfirmButton token={params.token} action={confirm} />
    </Shell>
  );
}

const text: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.6,
  color: '#8A9DBF',
  margin: '0 0 24px',
};

const linkButton: React.CSSProperties = {
  display: 'inline-block',
  background: 'transparent',
  color: '#38E1FF',
  border: '1px solid #1B2740',
  borderRadius: 8,
  padding: '10px 20px',
  fontSize: 14,
  fontWeight: 600,
  textDecoration: 'none',
};

function Shell({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#070B14',
        padding: 16,
      }}
    >
      <div
        style={{
          maxWidth: 440,
          width: '100%',
          background: '#0A1020',
          border: '1px solid #1B2740',
          borderRadius: 12,
          padding: '36px 32px',
          textAlign: 'center',
        }}
      >
        <h1
          style={{
            fontFamily: "'Chakra Petch', sans-serif",
            fontSize: 20,
            fontWeight: 700,
            color: '#EAF1FF',
            margin: '0 0 10px',
          }}
        >
          {heading}
        </h1>
        {children}
      </div>
    </div>
  );
}
