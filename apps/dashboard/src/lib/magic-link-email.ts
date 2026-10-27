// Table-based and fully inline-styled on purpose: the major email clients drop
// <style> blocks and have no flexbox, so the layout has to survive on
// attributes and inline CSS alone.

interface TransactionalEmail {
  heading: string;
  /** One or two sentences under the heading. Plain text, no markup. */
  body: string;
  /** Label on the button. */
  cta: string;
  url: string;
  /** Small print under the button. */
  footer: string;
}

/** Escapes text for interpolation into email HTML (element and attribute contexts). */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Shared shell for every transactional email the dashboard sends. */
function transactionalEmail({ heading, body, cta, url, footer }: TransactionalEmail): { html: string; text: string } {
  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#070B14;">
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#070B14;padding:40px 16px;">
      <tr>
        <td align="center">
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:440px;background:#0A1020;border:1px solid #1B2740;border-radius:12px;padding:40px 32px;">
            <tr>
              <td align="center" style="font-family:Helvetica,Arial,sans-serif;color:#EAF1FF;font-size:20px;font-weight:700;padding-bottom:8px;">
                ${escapeHtml(heading)}
              </td>
            </tr>
            <tr>
              <td align="center" style="font-family:Helvetica,Arial,sans-serif;color:#6B7C9E;font-size:14px;line-height:20px;padding-bottom:28px;">
                ${escapeHtml(body)}
              </td>
            </tr>
            <tr>
              <td align="center" style="padding-bottom:28px;">
                <a href="${escapeHtml(url)}" style="display:inline-block;background:#38E1FF;color:#04222B;font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">
                  ${escapeHtml(cta)}
                </a>
              </td>
            </tr>
            <tr>
              <td align="center" style="font-family:Helvetica,Arial,sans-serif;color:#6B7C9E;font-size:12px;line-height:18px;">
                ${escapeHtml(footer)}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = `${heading}\n\n${body}\n\n${url}\n\n${footer}\n`;

  return { html, text };
}

export function magicLinkEmail(url: string): { html: string; text: string } {
  return transactionalEmail({
    heading: 'Sign in to WhiteRoom',
    body: 'Click below to finish signing in. This link expires in 24 hours and can only be used once.',
    cta: 'Confirm sign-in',
    url,
    footer: "If you didn't request this, you can ignore this email.",
  });
}

export function emailChangeEmail(url: string, currentEmail: string): { html: string; text: string } {
  return transactionalEmail({
    heading: 'Confirm your new email',
    body: `Confirm this address to move your WhiteRoom account from ${currentEmail}. The link expires in 1 hour and can only be used once. Until you confirm, sign-in stays on your current address.`,
    cta: 'Confirm new email',
    url,
    footer: "If you didn't request this, you can ignore this email — nothing will change.",
  });
}

/**
 * The email that starts a 14-day closing window (account deleted, or plan
 * lapsed). Says what happens and when, never how WhiteRoom does it.
 */
export function accountClosingEmail(
  reason: 'deleted' | 'lapsed',
  date: string,
  settingsUrl: string,
): { subject: string; html: string; text: string } {
  const email = reason === 'deleted'
    ? transactionalEmail({
        heading: 'Your account will be deleted',
        body: `Your WhiteRoom account and fleet will be deleted on ${date}. Until then your fleet keeps working, and you can download your data or cancel the deletion in Settings. After that, your WhiteRoom fleet key stops working and calls through it are refused. The audit trail is kept for 12 months.`,
        cta: 'Open Settings',
        url: settingsUrl,
        footer: "If you didn't ask for this, cancel the deletion in Settings and sign out everywhere.",
      })
    : transactionalEmail({
        heading: 'Your WhiteRoom plan has ended',
        body: `Your fleet keeps working until ${date}. After that, your WhiteRoom fleet key stops working and calls through it are refused. Choose a plan before then to keep your fleet, or download your data from Settings. The audit trail is kept for 12 months.`,
        cta: 'Choose a plan',
        url: settingsUrl,
        footer: 'Choosing a plan before that date keeps everything as it is.',
      });
  return { subject: reason === 'deleted' ? 'Your WhiteRoom account will be deleted' : 'Your WhiteRoom plan has ended', ...email };
}

/** Sent once when an account's deletion window ends but something stops the deletion. */
export function deletionBlockedEmail(why: string, settingsUrl: string): { subject: string; html: string; text: string } {
  return {
    subject: "Your WhiteRoom account wasn't deleted yet",
    ...transactionalEmail({
      heading: "Your account wasn't deleted yet",
      body: `${why} We'll delete your account once that's done.`,
      cta: 'Open Settings',
      url: settingsUrl,
      footer: 'Your fleet is already closed. Nothing else changes until then.',
    }),
  };
}
