/** The request header that carries the per-request CSP nonce from proxy.ts to the root layout. */
export const NONCE_HEADER = 'x-nonce';

/** Where browsers send violation reports (app/api/csp-report). */
export const CSP_REPORT_PATH = '/api/csp-report';

/**
 * The page policy, enforced: only nonce'd scripts (and what they load) may
 * run, so an injected script doesn't. It ran report-only first; 30 days of
 * production showed no violations from the app's own pages. Violations are
 * still reported (app/api/csp-report). The framing rules repeat
 * next.config.ts's static policy, because this header replaces that one on
 * every response the proxy handles.
 */
export function scriptPolicy(nonce: string): string {
  const dev = process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : '';
  return `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; report-uri ${CSP_REPORT_PATH}`;
}
