'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { SegmentedControl } from '@whiteroom/ui';
import { chooseTheme, storedTheme, type ThemeChoice } from '@/lib/theme';
import { ROUTES } from '@/lib/routes';
import { plural } from '@/lib/format';
import { TextSizeControl } from '@/components/TextSizeControl';

/**
 * Under the sidebar's pages, always in view: theme, text size (A / A+ / A++),
 * the organization link and sign out. They used to sit behind a ⋯ menu; the
 * sidebar has room for them, so nothing is hidden.
 */
export function SidebarPreferences({ organization, invitations }: { organization: string | null; invitations: number }) {
  const [theme, setTheme] = useState<ThemeChoice>('dark');
  useEffect(() => { setTheme(storedTheme()); }, []);

  return (
    <div className="wr-sidebar__prefs">
      <div className="wr-sidebar__eyebrow" aria-hidden="true">Theme</div>
      <SegmentedControl<ThemeChoice>
        label="Theme"
        value={theme}
        onChange={(t) => { setTheme(t); chooseTheme(t); }}
        options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'system', label: 'System' }]}
      />
      <div className="wr-sidebar__eyebrow" aria-hidden="true">Text size</div>
      <TextSizeControl compact />
      <div className="wr-sidebar__links">
        {organization !== null && (
          <Link href={ROUTES.organization} className="wr-sidebar__link">
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{organization || 'Organization'}</span>
            {invitations > 0 && <span className="wr-sidebar__count">{invitations} {plural(invitations, 'invite')}</span>}
          </Link>
        )}
        <a href={ROUTES.signOut} className="wr-sidebar__link wr-sidebar__link--bad">Sign out</a>
      </div>
    </div>
  );
}
