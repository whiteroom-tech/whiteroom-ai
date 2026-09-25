'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { adminCreateOrganization } from '@/lib/organization-admin-actions';

const field: React.CSSProperties = {
  background: 'var(--sunk)', border: '1px solid var(--line)', borderRadius: 7,
  padding: '9px 12px', color: 'var(--tx)', fontSize: 14, fontFamily: 'inherit',
};

/**
 * Creates an organization and lands on it. The owner is required: an
 * organization with nobody able to manage it from the customer side would be
 * stuck until someone came back here.
 */
export function CreateOrganizationForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState('');
  const [owner, setOwner] = useState('');
  const [error, setError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await adminCreateOrganization(name, owner);
      if (res.ok) router.push(`/admin/organizations/${res.orgId}`);
      else setError(res.error);
    });
  }

  const disabled = pending || !name.trim() || !owner.trim();

  return (
    <form
      onSubmit={submit}
      style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, padding: '18px 20px' }}
    >
      <div style={{ fontWeight: 700, fontSize: 14.5, marginBottom: 4 }}>New organization</div>
      <p style={{ fontSize: 12.5, color: 'var(--tx3)', margin: '0 0 12px' }}>
        The owner must already have a WhiteRoom account. They can invite the rest of their team from the Organization
        page in the dashboard, or you can add people here.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Company name"
          aria-label="Organization name"
          maxLength={120}
          style={{ ...field, flex: '1 1 200px' }}
        />
        <input
          type="email"
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
          placeholder="Owner's email"
          aria-label="Owner's email"
          style={{ ...field, flex: '1 1 240px' }}
        />
        <button
          type="submit"
          disabled={disabled}
          style={{
            fontSize: 13.5, fontWeight: 600, padding: '8px 16px', borderRadius: 7,
            background: 'var(--brand)', color: 'var(--bg)', border: '1px solid var(--brand)',
            cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1, fontFamily: 'inherit',
          }}
        >
          {pending ? 'Creating…' : 'Create'}
        </button>
      </div>
      {error && <p role="status" style={{ fontSize: 13, color: 'var(--bad)', margin: '10px 0 0' }}>{error}</p>}
    </form>
  );
}
