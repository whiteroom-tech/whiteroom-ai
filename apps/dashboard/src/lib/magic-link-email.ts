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
                ${heading}
              </td>
            </tr>
            <tr>
              <td align="center" style="font-family:Helvetica,Arial,sans-serif;color:#6B7C9E;font-size:14px;line-height:20px;padding-bottom:28px;">
                ${body}
              </td>
            </tr>
            <tr>
              <td align="center" style="padding-bottom:28px;">
                <a href="${url}" style="display:inline-block;background:#38E1FF;color:#04222B;font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">
                  ${cta}
                </a>
              </td>
            </tr>
            <tr>
              <td align="center" style="font-family:Helvetica,Arial,sans-serif;color:#6B7C9E;font-size:12px;line-height:18px;">
                ${footer}
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
