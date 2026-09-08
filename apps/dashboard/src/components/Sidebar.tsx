'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { FONT_DISPLAY } from '@whiteroom/ui';

type WrTheme = 'system' | 'light' | 'dark';

function applyTheme(theme: WrTheme) {
  const shell = document.querySelector('.wr-shell');
  if (!shell) return;
  if (theme === 'system') shell.removeAttribute('data-theme');
  else shell.setAttribute('data-theme', theme);
}

const THEME_ICON: Record<WrTheme, React.ReactNode> = {
  system: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></svg>,
  light: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="5" /><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" /></svg>,
  dark: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" /></svg>,
};

export type FleetPage = 'live' | 'analytics' | 'visualization';

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
  match?: (path: string) => boolean;
}

interface SoonItem {
  label: string;
  icon: React.ReactNode;
  group?: string;
}

const ICONS = {
  fleet: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /><rect x="14" y="12" width="7" height="9" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" /></svg>,
  analytics: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 20V10M12 20V4M6 20v-6" /></svg>,
  viz: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M12 5v2M12 17v2M5 12h2M17 12h2" /></svg>,
  sandbox: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" /><path d="M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12" /></svg>,
  watch: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 8v4l3 3" /><circle cx="12" cy="12" r="9" /></svg>,
  triage: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>,
  compliance: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 11l3 3 8-8" /><path d="M21 12v6a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2h11" /></svg>,
  eval: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 20V10M12 20V4M6 20v-6" /></svg>,
  builder: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z" /></svg>,
  settings: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M12 1v4M12 19v4M4.2 4.2l2.8 2.8M17 17l2.8 2.8M1 12h4M19 12h4M4.2 19.8L7 17M17 7l2.8-2.8" /></svg>,
};

const NAV_ITEMS: NavItem[] = [
  { href: '/fleet', label: 'Fleet', icon: ICONS.fleet, match: (p) => p === '/fleet' || (p.startsWith('/fleet') && !p.includes('tab=analytics')) },
  { href: '/fleet?tab=analytics', label: 'Analytics', icon: ICONS.analytics, match: (p) => p.includes('tab=analytics') },
  { href: '/sandbox', label: 'Sandbox', icon: ICONS.sandbox, match: (p) => p.startsWith('/sandbox') },
];

const SOON_ITEMS: SoonItem[] = [
  { label: 'Visualization', icon: ICONS.viz },
  { label: 'Watch trace', icon: ICONS.watch },
  { label: 'Triage', icon: ICONS.triage },
  { label: 'Compliance', icon: ICONS.compliance },
  { label: 'Eval results', icon: ICONS.eval, group: 'Evaluation' },
  { label: 'Builder', icon: ICONS.builder },
  { label: 'Settings', icon: ICONS.settings, group: 'Manage' },
];

export function Sidebar({ fleetId }: { fleetId?: string } & (
  | { active: FleetPage; onNavigate: (page: FleetPage) => void }
  | { active?: never; onNavigate?: never }
)) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const fullPath = pathname + (searchParams.toString() ? `?${searchParams.toString()}` : '');
  const [roadmapOpen, setRoadmapOpen] = useState(false);
  const [theme, setTheme] = useState<WrTheme>('system');

  useEffect(() => {
    const stored = localStorage.getItem('wr_theme') as WrTheme | null;
    if (stored && (stored === 'light' || stored === 'dark')) {
      setTheme(stored);
      applyTheme(stored);
    }
  }, []);

  function cycleTheme() {
    const order: WrTheme[] = ['system', 'light', 'dark'];
    const next = order[(order.indexOf(theme) + 1) % order.length];
    setTheme(next);
    if (next === 'system') localStorage.removeItem('wr_theme');
    else localStorage.setItem('wr_theme', next);
    applyTheme(next);
  }

  return (
    <aside style={{ borderRight: '1px solid var(--line)', padding: '16px 11px', display: 'flex', flexDirection: 'column', gap: 2, background: 'var(--card)', minHeight: 0, overflowY: 'auto' }}>
      <div className="flex items-center gap-2.5" style={{ padding: '5px 10px 18px' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--ok)', boxShadow: '0 0 9px var(--ok)', animation: 'pulse-dot 2s infinite' }} />
        <span style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 13.5, letterSpacing: 2.5, color: 'var(--tx)', whiteSpace: 'nowrap' as const }}>WHITE ROOM</span>
      </div>

      {NAV_ITEMS.map((item) => {
        const isActive = item.match ? item.match(fullPath) : fullPath === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            className="flex items-center gap-2.5"
            style={{
              padding: '8px 10px', borderRadius: 7, fontSize: 12.5, fontWeight: 600, textAlign: 'left' as const, width: '100%',
              textDecoration: 'none',
              background: isActive ? 'var(--brand-dim)' : 'transparent',
              color: isActive ? 'var(--brand)' : 'var(--tx2)',
            }}
          >
            {item.icon}
            <span>{item.label}</span>
          </Link>
        );
      })}

      <button
        onClick={() => setRoadmapOpen((p) => !p)}
        className="flex items-center gap-2.5"
        style={{ padding: '8px 10px', borderRadius: 7, fontSize: 11, fontWeight: 600, textAlign: 'left' as const, width: '100%', color: 'var(--tx3)', marginTop: 8, background: 'transparent' }}
      >
        <span style={{ fontSize: 9, width: 14, textAlign: 'center' as const }}>{roadmapOpen ? '▾' : '▸'}</span>
        <span>Coming Soon</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8.5, fontWeight: 700, letterSpacing: 0.6, background: 'var(--sunk)', color: 'var(--tx3)', border: '1px solid var(--line)', borderRadius: 99, padding: '1px 6px', marginLeft: 'auto' }}>{SOON_ITEMS.length}</span>
      </button>

      {roadmapOpen && SOON_ITEMS.map((item) => (
        <div
          key={item.label}
          className="flex items-center gap-2.5"
          style={{ padding: '6px 10px 6px 24px', fontSize: 11.5, fontWeight: 600, color: 'var(--tx3)', opacity: 0.5, cursor: 'default' }}
        >
          {item.icon}
          <span>{item.label}</span>
        </div>
      ))}

      <div style={{ marginTop: 'auto', padding: '11px 10px', borderTop: '1px solid var(--line)', fontSize: 10.5, color: 'var(--tx3)' }}>
        <div className="flex items-center justify-between" style={{ marginBottom: fleetId ? 0 : undefined }}>
          <span>White Room Beta</span>
          <button
            onClick={cycleTheme}
            title={`Theme: ${theme.charAt(0).toUpperCase() + theme.slice(1)}`}
            style={{ background: 'var(--sunk)', border: '1px solid var(--line)', borderRadius: 5, padding: '3px 7px', cursor: 'pointer', color: 'var(--tx3)', lineHeight: 1, display: 'flex', alignItems: 'center', gap: 4 }}
          >
            {THEME_ICON[theme]}
          </button>
        </div>
        {fleetId && <div style={{ fontFamily: 'var(--font-mono)', color: 'var(--brand2)', fontSize: 10, marginTop: 2 }}>{fleetId}</div>}
      </div>
    </aside>
  );
}
