const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export const EMAIL_FROM = process.env.AUTH_EMAIL_FROM || 'WhiteRoom <no-reply@whiteroom.tech>';

/**
 * Sends one transactional email through Resend.
 *
 * Throws on a non-2xx so callers can decide whether the failure is fatal —
 * for an email change it is (the user would be left waiting for a link that
 * never arrives), so requestEmailChange rolls its database row back.
 */
export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<void> {
  const apiKey = process.env.AUTH_RESEND_KEY;
  if (!apiKey) throw new Error('AUTH_RESEND_KEY is not configured');

  const res = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: EMAIL_FROM, ...opts }),
  });

  if (!res.ok) {
    throw new Error('Could not send the email.');
  }
}
