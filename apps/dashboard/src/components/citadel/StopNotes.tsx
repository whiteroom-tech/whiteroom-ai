import { SHARED_KEY_STOP_NOTE, UNNAMED_CALLS_REFUSED } from '@/lib/setup';
import { keyScopeLabel } from '@/lib/provider-key-form';

/** What both Stop confirmations add under their first line: unnamed calls, and shared keys. */
export function StopNotes() {
  return (
    <>
      <span style={{ display: 'block', marginTop: 8 }}>{UNNAMED_CALLS_REFUSED}</span>
      <span style={{ display: 'block', marginTop: 8 }}>{SHARED_KEY_STOP_NOTE}</span>
    </>
  );
}

/** A provider key's "only for <agent>" note; nothing for a fleet-wide key. */
export function KeyScopeNote({ agentId }: { agentId?: string }) {
  const label = keyScopeLabel({ agentId });
  return label ? <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--tx2)' }}>{label}</span> : null;
}
