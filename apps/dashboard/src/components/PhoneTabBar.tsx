'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { isNavActive } from '@/lib/routes';
import { NAV, NavIcon, type NavKey } from '@/components/nav-items';

/** On phones, the four pages people check most sit in the tab bar; More opens the menu with the rest. */
export const TAB_KEYS: readonly NavKey[] = ['home', 'performance', 'runs', 'controls'];
const ITEMS = NAV.flatMap((g) => g.items);
export const TABS = TAB_KEYS.map((k) => ITEMS.find((i) => i.key === k)!);
export const MORE = ITEMS.filter((i) => !TAB_KEYS.includes(i.key));

/**
 * The phone bottom tab bar (shown below 720px by globals.css). More toggles
 * the sidebar, which holds Sandbox, Fleet key, Settings and the account menu.
 */
export function PhoneTabBar({ menuOpen, onMore }: { menuOpen: boolean; onMore: () => void }) {
  const pathname = usePathname();
  const moreActive = MORE.some((i) => isNavActive(pathname, i.href, i.also));
  return (
    <nav className="wr-tabbar" aria-label="Main pages">
      {TABS.map((item) => {
        const active = !menuOpen && isNavActive(pathname, item.href, item.also);
        return (
          <Link key={item.key} href={item.href} aria-current={active ? 'page' : undefined} className={`wr-tabbar__item${active ? ' is-active' : ''}`}>
            <NavIcon name={item.key} size={20} />
            <span>{item.label}</span>
          </Link>
        );
      })}
      <button
        type="button"
        aria-expanded={menuOpen}
        aria-controls="wr-main-nav"
        onClick={onMore}
        className={`wr-tabbar__item${menuOpen || moreActive ? ' is-active' : ''}`}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" style={{ flex: 'none' }}>
          <path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth="3" />
        </svg>
        <span>More</span>
      </button>
    </nav>
  );
}
