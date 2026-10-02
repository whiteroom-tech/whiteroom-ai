import type { useRouter } from 'next/navigation';

/** Merge the given params into the current URL (null removes), replacing in place without a scroll reset. */
export function syncQueryParams(router: ReturnType<typeof useRouter>, params: Record<string, string | null>) {
  const sp = new URLSearchParams(window.location.search);
  let changed = false;
  for (const [k, v] of Object.entries(params)) {
    if (v == null) {
      if (sp.has(k)) { sp.delete(k); changed = true; }
    } else if (sp.get(k) !== v) {
      sp.set(k, v); changed = true;
    }
  }
  if (!changed) return;
  const qs = sp.toString();
  router.replace(qs ? `${window.location.pathname}?${qs}` : window.location.pathname, { scroll: false });
}
