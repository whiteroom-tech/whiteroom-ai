/** The request header that carries the per-request CSP nonce from proxy.ts to the root layout. */
export const NONCE_HEADER = 'x-nonce';

/** Where browsers send violation reports (app/api/csp-report). */
export const CSP_REPORT_PATH = '/api/csp-report';

/**
 * Only nonce'd scripts (and what they load) may run. Report-only for now:
 * browsers log violations without blocking, so nothing can break. Switch the
 * response header to Content-Security-Policy once production shows none.
 */
export function scriptPolicy(nonce: string): string {
  const dev = process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : '';
  return `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev}; object-src 'none'; base-uri 'self'; report-uri ${CSP_REPORT_PATH}`;
}
