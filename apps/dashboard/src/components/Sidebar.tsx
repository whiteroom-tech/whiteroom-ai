'use client';

import { FONT_DISPLAY } from '@whiteroom/ui';

export type FleetPage = 'live' | 'analytics' | 'visualization';

interface NavItem {
  page: FleetPage;
  label: string;
  icon: React.ReactNode;
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
  watch: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 8v4l3 3" /><circle cx="12" cy="12" r="9" /></svg>,
  triage: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>,
  compliance: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 11l3 3 8-8" /><path d="M21 12v6a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2h11" /></svg>,
  eval: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 20V10M12 20V4M6 20v-6" /></svg>,
  builder: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z" /></svg>,
  settings: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M12 1v4M12 19v4M4.2 4.2l2.8 2.8M17 17l2.8 2.8M1 12h4M19 12h4M4.2 19.8L7 17M17 7l2.8-2.8" /></svg>,
};

const NAV_ITEMS: NavItem[] = [
  { page: 'live', label: 'Fleet', icon: ICONS.fleet },
  { page: 'analytics', label: 'Analytics', icon: ICONS.analytics },
  { page: 'visualization', label: 'Visualization', icon: ICONS.viz },
];

// These don't exist yet — no page, no data. Shown dimmed as a roadmap
// preview rather than dropped, per product's call; deliberately not
// clickable so nothing pretends to be a working page.
const SOON_ITEMS: SoonItem[] = [
  { label: 'Watch trace', icon: ICONS.watch },
  { label: 'Triage', icon: ICONS.triage },
  { label: 'Compliance', icon: ICONS.compliance },
  { label: 'Eval results', icon: ICONS.eval, group: 'Evaluation' },
  { label: 'Builder', icon: ICONS.builder },
  { label: 'Settings', icon: ICONS.settings, group: 'Manage' },
];

export function Sidebar({ active, onNavigate, fleetId }: { active: FleetPage; onNavigate: (page: FleetPage) => void; fleetId: string }) {
  let lastGroup: string | undefined;
  return (
    <aside style={{ borderRight: '1px solid var(--line)', padding: '16px 11px', display: 'flex', flexDirection: 'column', gap: 2, background: 'var(--card)', minHeight: 0, overflowY: 'auto' }}>
      <div className="flex items-center gap-2.5" style={{ padding: '5px 10px 18px' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--ok)', boxShadow: '0 0 9px var(--ok)', animation: 'pulse-dot 2s infinite' }} />
        <span style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 13.5, letterSpacing: 2.5, color: 'var(--tx)', whiteSpace: 'nowrap' as const }}>WHITE ROOM</span>
      </div>

      {NAV_ITEMS.map((item) => (
        <button
          key={item.page}
          onClick={() => onNavigate(item.page)}
          className="flex items-center gap-2.5"
          style={{
            padding: '8px 10px', borderRadius: 7, fontSize: 12.5, fontWeight: 600, textAlign: 'left' as const, width: '100%',
            background: active === item.page ? 'var(--brand-dim)' : 'transparent',
            color: active === item.page ? 'var(--brand)' : 'var(--tx2)',
          }}
        >
          {item.icon}
          <span>{item.label}</span>
        </button>
      ))}

      {SOON_ITEMS.map((item) => {
        const groupHeader = item.group && item.group !== lastGroup ? item.group : null;
        lastGroup = item.group ?? lastGroup;
        return (
          <div key={item.label}>
            {groupHeader && (
              <div style={{ padding: '15px 10px 5px', fontSize: 10, fontWeight: 700, letterSpacing: 1.2, color: 'var(--tx3)', textTransform: 'uppercase' as const }}>{groupHeader}</div>
            )}
            <div
              className="flex items-center gap-2.5"
              style={{ padding: '8px 10px', borderRadius: 7, fontSize: 12.5, fontWeight: 600, color: 'var(--tx3)', opacity: 0.6, cursor: 'default' }}
            >
              {item.icon}
              <span style={{ flex: 1 }}>{item.label}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8.5, fontWeight: 700, letterSpacing: 0.6, background: 'var(--sunk)', color: 'var(--tx3)', border: '1px solid var(--line)', borderRadius: 99, padding: '1px 6px' }}>SOON</span>
            </div>
          </div>
        );
      })}

      <div style={{ marginTop: 'auto', padding: '11px 10px', borderTop: '1px solid var(--line)', fontSize: 10.5, color: 'var(--tx3)' }}>
        White Room Beta
        <div style={{ fontFamily: 'var(--font-mono)', color: 'var(--brand2)', fontSize: 10, marginTop: 2 }}>{fleetId}</div>
      </div>
    </aside>
  );
}
