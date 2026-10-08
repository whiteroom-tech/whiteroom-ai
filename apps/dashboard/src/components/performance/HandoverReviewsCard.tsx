'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { StatCard } from '@whiteroom/ui';
import { handoverReviewStatus, type HandoverReviewStatus } from '@/lib/whiteroom/client';
import { HELP } from '@/lib/metric-definitions';
import { reviewSpendLine, usd } from '@/lib/handover-review';

/**
 * Performance › Handover reviews (compression spec §14.1): this month's review
 * spend against its own limit, apart from agent spend. Shown only once
 * reviews are on or have run; hidden on engines without them.
 */
export function HandoverReviewsCard({ fleetId }: { fleetId: string }) {
  const [s, setS] = useState<HandoverReviewStatus | null | 'failed'>(null);
  useEffect(() => {
    setS(null);
    let live = true;
    // null from an engine without reviews hides the card; a failed fetch says so.
    handoverReviewStatus(fleetId).then((r) => { if (live) setS(r); }, () => { if (live) setS('failed'); });
    return () => { live = false; };
  }, [fleetId]);

  if (s === 'failed') {
    return (
      <div style={{ maxWidth: 320, margin: '0 0 16px' }}>
        <StatCard variant="card" label="Handover reviews" hint={HELP.handoverReviews} value="—" sub="Unavailable" />
      </div>
    );
  }
  if (!s || (s.review_mode !== 'realtime' && s.reviews === 0)) return null;
  const used = s.spent_usd + s.reserved_usd;
  // The limit warnings Settings shows (reached, or reviews from an earlier limit finishing) show here too.
  const line = reviewSpendLine(s);
  return (
    <div style={{ maxWidth: 320, margin: '0 0 16px' }}>
      <StatCard
        variant="card"
        label="Handover reviews"
        hint={HELP.handoverReviews}
        value={usd(used)}
        sub={line.warn
          ? <><span style={{ color: 'var(--warn-tx)' }}>{line.text}</span> · <Link href="/settings" className="wr-link">Settings</Link></>
          : <>{s.cap_usd != null ? `of ${usd(s.cap_usd)} this month` : 'this month'} · never stops your agents · <Link href="/settings" className="wr-link">Settings</Link></>}
      />
    </div>
  );
}
