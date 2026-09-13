'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * The POST half of the confirmation.
 *
 * Kept a client component so the token is only redeemed on a real click —
 * see the note on the page that renders it.
 */
export function ConfirmButton({
  token,
  action,
}: {
  token: string;
  action: (token: string) => Promise<{ ok: boolean; newEmail?: string; error?: string }>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <button
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const res = await action(token);
        if (res.ok && res.newEmail) {
          router.replace(`/settings/confirm-email?done=${encodeURIComponent(res.newEmail)}`);
        } else {
          router.replace(`/settings/confirm-email?error=${encodeURIComponent(res.error ?? 'Could not confirm that email.')}`);
        }
      }}
      style={{
        background: '#38E1FF',
        color: '#04222B',
        border: 'none',
        borderRadius: 8,
        padding: '12px 28px',
        fontSize: 14,
        fontWeight: 600,
        cursor: busy ? 'not-allowed' : 'pointer',
        opacity: busy ? 0.6 : 1,
        fontFamily: 'inherit',
      }}
    >
      {busy ? 'Confirming…' : 'Confirm new email'}
    </button>
  );
}
