'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Search lives in the URL rather than in component state.
 *
 * It makes a result set linkable — the thing you want when you're pasting an
 * account into a support thread — and keeps the list itself a server component
 * that queries the database directly, with no action round trip.
 */
export function UserSearch({ initialQuery }: { initialQuery: string }) {
  const router = useRouter();
  const [value, setValue] = useState(initialQuery);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = value.trim();
    // Dropping `page` is deliberate: keeping it would land a new search on
    // page 4 of results that may only have one page.
    router.push(q ? `/admin?q=${encodeURIComponent(q)}` : '/admin');
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', gap: 8 }}>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search by email or name"
        aria-label="Search accounts by email or name"
        style={{
          flex: 1,
          background: 'var(--sunk)',
          border: '1px solid var(--line)',
          borderRadius: 7,
          padding: '9px 12px',
          color: 'var(--tx)',
          fontSize: 14,
          fontFamily: 'inherit',
        }}
      />
      <button
        type="submit"
        style={{
          fontSize: 13.5, fontWeight: 600, padding: '8px 16px', borderRadius: 7,
          background: 'var(--brand)', color: 'var(--bg)', border: '1px solid var(--brand)',
          cursor: 'pointer', fontFamily: 'inherit',
        }}
      >
        Search
      </button>
      {initialQuery && (
        <button
          type="button"
          onClick={() => { setValue(''); router.push('/admin'); }}
          style={{
            fontSize: 13.5, fontWeight: 600, padding: '8px 16px', borderRadius: 7,
            background: 'transparent', color: 'var(--tx2)', border: '1px solid var(--line2)',
            cursor: 'pointer', fontFamily: 'inherit',
          }}
        >
          Clear
        </button>
      )}
    </form>
  );
}
