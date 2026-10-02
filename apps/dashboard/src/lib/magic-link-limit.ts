/** Sign-in emails one address can be sent per 10 minutes. */
export const MAGIC_LINKS_PER_WINDOW = 3;

type Query = (sql: string, params: unknown[]) => Promise<{ rows: { n: number }[] }>;

/**
 * True once an address has had more than MAGIC_LINKS_PER_WINDOW sign-in links
 * in the last 10 minutes, so the form can't flood an inbox or burn the sending
 * domain's reputation. Tokens store only their expiry (now + maxAge), so a
 * token created in the window expires within maxAge of now.
 */
export async function tooManyMagicLinks(query: Query, identifier: string, maxAgeSeconds: number): Promise<boolean> {
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM verification_token
      WHERE identifier = $1 AND expires > now() + make_interval(secs => $2) - interval '10 minutes'`,
    [identifier, maxAgeSeconds],
  );
  return (rows[0]?.n ?? 0) > MAGIC_LINKS_PER_WINDOW;
}
