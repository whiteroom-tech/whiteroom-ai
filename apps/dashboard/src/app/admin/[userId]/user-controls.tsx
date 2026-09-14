'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { resyncEntitlements, setPlanOverride } from '@/lib/admin-actions';
import { PLAN_IDS, PLANS } from '@/lib/plans';

/**
 * The two mutations the panel offers.
 *
 * Neither trusts anything rendered here — both actions re-read the caller's
 * role from the database before doing anything. This component only decides
 * what to show.
 */
export function UserControls({ userId, currentOverride }: { userId: string; currentOverride: string | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [choice, setChoice] = useState(currentOverride ?? '');
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  function run(action: () => Promise<{ ok: boolean; error?: string }>, success: string) {
    setMessage(null);
    startTransition(async () => {
      const res = await action();
      if (res.ok) {
        setMessage({ tone: 'ok', text: success });
        router.refresh();
      } else {
        setMessage({ tone: 'bad', text: res.error ?? 'Something went wrong.' });
      }
    });
  }

  const dirty = choice !== (currentOverride ?? '');

  return (
    <div style={{ marginTop: 20, paddingTop: 18, borderTop: '1px solid var(--line)' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 200px' }}>
          <label
            htmlFor="override"
            style={{ display: 'block', fontSize: 11, fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--tx3)', marginBottom: 6 }}
          >
            Comp a plan
          </label>
          <select
            id="override"
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
            style={{
              width: '100%', background: 'var(--sunk)', border: '1px solid var(--line)',
              borderRadius: 7, padding: '9px 11px', color: 'var(--tx)', fontSize: 14, fontFamily: 'inherit',
            }}
          >
            <option value="">No override — follow Stripe</option>
            {PLAN_IDS.map((p) => (
              <option key={p} value={p}>{PLANS[p].name}</option>
            ))}
          </select>
        </div>

        <button
          disabled={pending || !dirty}
          onClick={() =>
            run(
              () => setPlanOverride(userId, choice === '' ? null : choice),
              choice === '' ? 'Override cleared.' : `Comped to ${PLANS[choice as keyof typeof PLANS].name}.`,
            )
          }
          style={btn('primary', pending || !dirty)}
        >
          {pending ? 'Saving…' : 'Apply'}
        </button>

        <button
          disabled={pending}
          onClick={() => run(() => resyncEntitlements(userId), 'Entitlements pushed to the engine.')}
          style={btn('ghost', pending)}
        >
          Re-sync to engine
        </button>
      </div>

      <p style={{ fontSize: 12.5, color: 'var(--tx3)', margin: '10px 0 0', maxWidth: '62ch' }}>
        A comp overrides Stripe in both directions and survives the next webhook. Re-sync is for
        when a customer&apos;s limits don&apos;t match what they&apos;re paying for — the push is
        best-effort and can miss during an engine deploy.
      </p>

      {message && (
        <p
          role="status"
          style={{
            fontSize: 13, margin: '12px 0 0',
            color: message.tone === 'ok' ? 'var(--ok)' : 'var(--bad)',
          }}
        >
          {message.text}
        </p>
      )}
    </div>
  );
}

function btn(variant: 'primary' | 'ghost', disabled: boolean): React.CSSProperties {
  return {
    fontSize: 13.5,
    fontWeight: 600,
    padding: '9px 16px',
    borderRadius: 7,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
    background: variant === 'primary' ? 'var(--brand)' : 'transparent',
    color: variant === 'primary' ? 'var(--bg)' : 'var(--tx2)',
    border: `1px solid ${variant === 'primary' ? 'var(--brand)' : 'var(--line2)'}`,
  };
}
