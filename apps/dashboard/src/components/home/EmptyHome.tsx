'use client';

import Link from 'next/link';
import { Icon, Panel, FONT_MONO } from '@whiteroom/ui';
import { CopyChip } from '@/components/citadel/CopyChip';
import { SETUP_GUIDE_URL, SETUP_LINES } from '@/lib/setup';
import { ROUTES } from '@/lib/routes';

/**
 * Home with no agents yet (README › Screens › 8). The strip, Agents, Activity
 * and Live feed stay hidden; Home polls every 5 s and swaps to the populated
 * view on the first call.
 */
export function EmptyHome() {
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 24 }}>
      <div style={{ maxWidth: 560, margin: '24px auto 0' }}>
        <Panel bodyPadding="28px 30px">
          <div style={{ display: 'grid', gap: 16 }}>
            <span style={{ color: 'var(--brand)', display: 'flex' }}><Icon name="box" size={28} strokeWidth={1.8} /></span>
            <div>
              <h2 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600 }}>No agents connected yet</h2>
              <p style={{ margin: '6px 0 0', fontSize: 13.5, lineHeight: 1.55, color: 'var(--tx2)' }}>
                Point an agent at the WhiteRoom proxy and it appears here on its first call. Nothing else changes in your code.
              </p>
            </div>
            <ol className="wr-steps">
              <li>
                <span>Change one URL so your agent&rsquo;s calls go through WhiteRoom.</span>
                <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
                  {Object.values(SETUP_LINES).map((l) => <CopyChip key={l} text={l} />)}
                </div>
              </li>
              <li><span>Run your agent exactly as before. No CLI commands needed.</span></li>
            </ol>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--tx2)' }}>
              Using Azure OpenAI or your own provider key? <Link href={ROUTES.fleetKey} className="wr-link">Fleet key &rarr;</Link>
            </p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', paddingTop: 4 }}>
              <Link href={ROUTES.sandbox} className="wr-btn wr-btn--primary wr-btn--h32">Test in Sandbox &rarr;</Link>
              <a href={SETUP_GUIDE_URL} target="_blank" rel="noopener noreferrer" className="wr-btn wr-btn--ghost wr-btn--h32">Read the setup guide</a>
              <span style={{ marginLeft: 'auto', fontFamily: FONT_MONO, fontSize: 11.5, color: 'var(--tx2)' }}>Checks for a call every 5 s</span>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}
