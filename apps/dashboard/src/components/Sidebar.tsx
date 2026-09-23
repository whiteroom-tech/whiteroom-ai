'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
  match: (path: string, tab: string | null) => boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
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
  performance: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg>,
};

const NAV_GROUPS: NavGroup[] = [
  {
    label: 'AGENTS',
    items: [
      {
        href: '/agents',
        label: 'Live Fleet',
        icon: ICONS.fleet,
        match: (path, tab) =>
          (path === '/agents' && tab !== 'performance') ||
          path === '/fleet',
      },
      {
        href: '/runs',
        label: 'Run History',
        icon: ICONS.analytics,
        match: (path) => path === '/runs',
      },
      {
        href: '/performance',
        label: 'Performance',
        icon: ICONS.performance,
        match: (path) => path === '/performance',
      },
      {
        href: '/controls',
        label: 'Sandbox',
        icon: ICONS.sandbox,
        match: (path) => path === '/sandbox' || path === '/controls',
      },
    ],
  },
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

export function Sidebar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab = searchParams.get('tab');
  const [roadmapOpen, setRoadmapOpen] = useState(false);

  const [fleetId, setFleetId] = useState<string | null>(null);
  useEffect(() => {
    const read = () => {
      try { setFleetId(localStorage.getItem('wr_fleet')); }
      catch { setFleetId(null); }
    };
    read();
    window.addEventListener('storage', read);
    window.addEventListener('focus', read);
    return () => { window.removeEventListener('storage', read); window.removeEventListener('focus', read); };
  }, []);

  return (
    <aside style={{ borderRight: '1px solid var(--line)', padding: '16px 11px', display: 'flex', flexDirection: 'column', gap: 2, background: 'var(--card)', minHeight: 0, overflowY: 'auto' }}>
      <div style={{ padding: '5px 10px 18px', display: 'flex', alignItems: 'center', gap: 12 }}>
        <svg width="40" height="40" viewBox="0 0 48 48" style={{ flex: 'none' }}>
          <circle cx="24" cy="24" r="14" fill="none" stroke="#4a5f78" strokeWidth="1" />
          <circle cx="24" cy="24" r="7" fill="none" stroke="#4a5f78" strokeWidth="1" />
          <path d="M24 3V45M3 24H45" stroke="#4a5f78" strokeWidth="1" />
          <g className="cr-sweep" style={{ transformBox: 'view-box' as const, transformOrigin: '24px 24px', animation: 'cr-spin 4s linear infinite' }}>
            <path d="M24 24L9.15 9.15A21 21 0 0 1 24 3Z" fill="#34d399" opacity="0.30" />
            <path d="M24 24V3" stroke="#34d399" strokeWidth="2" />
          </g>
          <circle cx="24" cy="24" r="21" fill="none" stroke="var(--tx)" strokeWidth="2" />
          <circle cx="31" cy="14" r="2.2" fill="#34d399" />
          <circle cx="14" cy="30" r="1.7" fill="#34d399" opacity="0.55" />
          <circle cx="24" cy="24" r="1.6" fill="var(--tx)" />
        </svg>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontFamily: "'Saira', 'Barlow', sans-serif", fontWeight: 700, fontSize: 20, lineHeight: 1, letterSpacing: '0.16em', color: 'var(--tx)' }}>CITADEL</span>
          <span style={{ fontFamily: "'Martian Mono', ui-monospace, monospace", fontWeight: 500, fontSize: 9.5, lineHeight: 1, letterSpacing: '0.22em', color: 'var(--cr-cyan)' }}>CONTROL ROOM</span>
        </div>
      </div>

      {NAV_GROUPS.map((group) => (
        <div key={group.label} style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 1.5, color: 'var(--tx3)', padding: '8px 10px 4px', textTransform: 'uppercase' as const }}>
            {group.label}
          </div>
          {group.items.map((item) => {
            const isActive = item.match(pathname, tab);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive ? 'page' : undefined}
                className="flex items-center gap-2.5"
                style={{
                  padding: '8px 10px', borderRadius: 7, fontSize: 14, fontWeight: 600, textAlign: 'left' as const, width: '100%',
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
        </div>
      ))}

      <button
        onClick={() => setRoadmapOpen((p) => !p)}
        className="flex items-center gap-2.5"
        style={{ padding: '8px 10px', borderRadius: 7, fontSize: 12.5, fontWeight: 600, textAlign: 'left' as const, width: '100%', color: 'var(--tx3)', marginTop: 8, background: 'transparent' }}
      >
        <span style={{ fontSize: 10.5, width: 14, textAlign: 'center' as const }}>{roadmapOpen ? '▾' : '▸'}</span>
        <span>Coming Soon</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, letterSpacing: 0.6, background: 'var(--sunk)', color: 'var(--tx3)', border: '1px solid var(--line)', borderRadius: 99, padding: '1px 6px', marginLeft: 'auto' }}>{SOON_ITEMS.length}</span>
      </button>

      {roadmapOpen && SOON_ITEMS.map((item) => (
        <div
          key={item.label}
          className="flex items-center gap-2.5"
          style={{ padding: '6px 10px 6px 24px', fontSize: 13, fontWeight: 600, color: 'var(--tx3)', opacity: 0.5, cursor: 'default' }}
        >
          {item.icon}
          <span>{item.label}</span>
        </div>
      ))}

      <div style={{ marginTop: 'auto', padding: '11px 10px', borderTop: '1px solid var(--line)', fontSize: 12, color: 'var(--tx3)' }}>
        <span>White Room Beta</span>
        {fleetId && <div style={{ fontFamily: 'var(--font-mono)', color: 'var(--brand2)', fontSize: 11.5, marginTop: 2 }}>{fleetId}</div>}
      </div>
    </aside>
  );
}
