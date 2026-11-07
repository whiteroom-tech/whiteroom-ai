// The fleet app's pages, shared by the sidebar and the phone tab bar.
import { ROUTES } from '@/lib/routes';

// 24-unit line icons, stroke 2 (README › Global shell › Icons).
export const ICON_PATHS = {
  home: 'M3 11l9-8 9 8v10a1 1 0 01-1 1h-5v-7h-6v7H4a1 1 0 01-1-1z',
  runs: 'M4 6h16M4 12h16M4 18h10',
  performance: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z',
  controls: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  sandbox: 'M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16zM3.3 7l8.7 5 8.7-5M12 22V12',
  fleetKey: 'M15 7a4 4 0 11-3.9 5H3v3h3v3h3v-3h2.1A4 4 0 0115 7zM16 10h.01',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z',
};

export type NavKey = keyof typeof ICON_PATHS;

interface NavItem {
  key: NavKey;
  href: string;
  label: string;
  /** Native tooltip in plain words (README › Labels and hover help). */
  tip: string;
  /** Extra paths that count as this page, e.g. old routes. */
  also?: string[];
}

export const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: 'Monitor',
    items: [
      { key: 'home', href: ROUTES.home, label: 'Home', tip: 'Does anything need you, and what is the fleet doing right now', also: ['/fleet'] },
      { key: 'performance', href: ROUTES.performance, label: 'Performance', tip: 'Cost, savings, errors and unusual behaviour over time' },
      { key: 'runs', href: ROUTES.runs, label: 'Runs', tip: 'Every stretch of work by every agent, and what happened in it' },
    ],
  },
  {
    group: 'Govern',
    items: [
      { key: 'controls', href: ROUTES.controls, label: 'Controls', tip: 'Rules for your agents, and what they do when one is broken' },
    ],
  },
  {
    group: 'Setup',
    items: [
      { key: 'sandbox', href: ROUTES.sandbox, label: 'Sandbox', tip: 'Try an agent on a test task before it touches real work' },
      { key: 'fleetKey', href: ROUTES.fleetKey, label: 'Fleet key', tip: 'Your WhiteRoom fleet key and proxy address, needed to connect an agent' },
      { key: 'settings', href: ROUTES.settings, label: 'Settings', tip: 'Profile, plan, alerts and sign-in' },
    ],
  },
];

export function NavIcon({ name, size = 15 }: { name: NavKey; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none' }}>
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
