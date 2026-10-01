'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { SegmentedControl } from '@whiteroom/ui';
import { chooseTheme, storedTheme, type ThemeChoice } from '@/lib/theme';
import { ROUTES } from '@/lib/routes';

/**
 * The ⋯ menu on the sidebar's account row: theme, the organization link and
 * sign out (README › Global shell). These used to sit in every page header.
 * Esc or a click outside closes it and returns focus to the button.
 */
export function AccountMenu({ organization, invitations }: { organization: string | null; invitations: number }) {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeChoice>('dark');
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => { setTheme(storedTheme()); }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); button.current?.focus(); }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    // Focus the selected theme, the entry point of that radio group.
    menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  function pick(t: ThemeChoice) {
    setTheme(t);
    chooseTheme(t);
  }

  return (
    // The menu is positioned against the sidebar's account row, not this
    // button, so it spans the sidebar's width instead of running off-screen.
    <div style={{ flex: 'none' }}>
      <button
        ref={button}
        type="button"
        aria-label={invitations > 0 ? `Account menu, ${invitations} pending invitation${invitations === 1 ? '' : 's'}` : 'Account menu'}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title="Theme, organization, sign out"
        className="wr-account-btn"
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
        {invitations > 0 && <span className="wr-account-btn__dot" aria-hidden="true" />}
      </button>
      {open && (
        <div ref={menu} id={id} role="group" aria-label="Account" className="wr-account-menu">
          <div className="wr-account-menu__label">Theme</div>
          <SegmentedControl<ThemeChoice>
            label="Theme"
            value={theme}
            onChange={pick}
            size={24}
            options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'system', label: 'System' }]}
          />
          {organization !== null && (
            <Link href={ROUTES.organization} className="wr-account-menu__item" onClick={() => setOpen(false)}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{organization || 'Organization'}</span>
              {invitations > 0 && <span className="wr-account-menu__count">{invitations} invite{invitations === 1 ? '' : 's'}</span>}
            </Link>
          )}
          <a href={ROUTES.signOut} className="wr-account-menu__item wr-account-menu__item--bad">Sign out</a>
        </div>
      )}
    </div>
  );
}
