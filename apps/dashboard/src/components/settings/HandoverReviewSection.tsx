'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Panel, Toggle, FONT_MONO } from '@whiteroom/ui';
import { ConfirmDialog } from '@/components/citadel/ConfirmDialog';
import { dataSettingsGet, dataSettingsSet, handoverReviewStatus, type DataSettings, type HandoverReviewStatus } from '@/lib/whiteroom/client';
import { useFleetAuth } from '@/hooks/useFleetAuth';
import { reviewSpendLine, usd } from '@/lib/handover-review';

const MAX_LIMIT = 100_000;

type Pending = { patch: Partial<DataSettings>; title: string; body: string; confirm: string; cancel: string };

/**
 * Settings › Handover review (compression spec §14.1): an opt-in second look
 * at a sample of handovers, billed to the fleet's own provider key up to a
 * monthly limit. Turning it on and lowering the limit ask first; nothing
 * changes on screen until the engine confirms. Hidden on engines without it.
 */
export function HandoverReviewSection() {
  const { fleetId, status: authStatus } = useFleetAuth();
  const [settings, setSettings] = useState<DataSettings | null>(null);
  const [status, setStatus] = useState<HandoverReviewStatus | null>(null);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // The fleet on screen now: a save or fetch that finishes after a fleet switch is dropped.
  const current = useRef(fleetId);
  current.current = fleetId;

  useEffect(() => {
    setSettings(null);
    setStatus(null);
    if (authStatus !== 'authenticated' || !fleetId) return;
    let live = true;
    dataSettingsGet(fleetId).then((s) => {
      if (!live || !s || s.review_mode === undefined) return;
      setSettings(s);
      setDraft(s.review_monthly_cap_usd != null ? String(s.review_monthly_cap_usd) : '');
    }, () => {});
    handoverReviewStatus(fleetId).then((s) => { if (live) setStatus(s); }, () => {});
    return () => { live = false; };
  }, [fleetId, authStatus]);

  if (!fleetId || !settings) return null;

  const on = settings.review_mode === 'realtime';
  const limit = settings.review_monthly_cap_usd ?? null;
  const parsed = Number(draft);
  const draftValid = draft.trim() !== '' && Number.isFinite(parsed) && parsed >= 1 && parsed <= MAX_LIMIT;
  const draftLimit = draftValid ? Math.round(parsed * 100) / 100 : null;

  async function save(patch: Partial<DataSettings>) {
    const fleet = fleetId!;
    setBusy(true);
    setNote(null);
    try {
      const next = await dataSettingsSet(fleet, patch);
      if (current.current !== fleet) return;
      if (next) {
        setSettings((s) => (s ? { ...s, review_mode: next.review_mode, review_monthly_cap_usd: next.review_monthly_cap_usd } : s));
        setDraft(next.review_monthly_cap_usd != null ? String(next.review_monthly_cap_usd) : '');
      }
      setPending(null);
      handoverReviewStatus(fleet).then((s) => { if (current.current === fleet) setStatus(s); }, () => {});
    } catch (e) {
      if (current.current !== fleet) return;
      setNote(e instanceof Error ? e.message : 'That didn’t save. Try again.');
      setPending(null);
    } finally {
      setBusy(false);
    }
  }

  const askTurnOn = () => {
    if (draftLimit === null) { setNote('Set a monthly limit first, from $1 to $100,000.'); return; }
    setPending({
      patch: { review_mode: 'realtime', review_monthly_cap_usd: draftLimit },
      title: 'Turn on handover review?',
      body: `WhiteRoom reviews a sample of handovers, plus any that look off, to check nothing important was lost. Reviews use your own model key, so your provider bills them, up to ${usd(draftLimit)} a month. Only the results are kept, never the text. Reviews never stop your agents, though they share your key’s rate limits with them.`,
      confirm: 'Turn on reviews', cancel: 'Not now',
    });
  };

  const saveLimit = () => {
    if (draftLimit === null || draftLimit === limit) return;
    if (on && limit !== null && draftLimit < limit) {
      setPending({
        patch: { review_monthly_cap_usd: draftLimit },
        title: `Lower the limit to ${usd(draftLimit)}?`,
        body: `Reviews already started finish and count toward this month. No new reviews start while this month’s review spend is over ${usd(draftLimit)}.`,
        confirm: `Change to ${usd(draftLimit)}`, cancel: 'Cancel',
      });
      return;
    }
    void save({ review_monthly_cap_usd: draftLimit });
  };

  const spend = status && on ? reviewSpendLine(status) : null;

  return (
    <Panel title="Handover review">
      <p style={{ fontSize: 13, color: 'var(--tx2)', margin: '0 0 6px', maxWidth: '62ch' }}>
        A second look at a sample of handovers, to check nothing important was lost. Uses your own model key, so it adds to your provider bill, up to a monthly limit you set. For fleet <span style={{ fontFamily: FONT_MONO }}>{fleetId}</span>.
      </p>

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap', padding: '14px 0', borderBottom: '1px solid var(--line)' }}>
        <div style={{ flex: '1 1 320px', minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Review handovers</div>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--tx2)', maxWidth: '58ch' }}>
            {on ? 'On. Results show on each agent’s Handover quality panel.' : 'Off. No reviews run and nothing is billed.'}
          </p>
        </div>
        <div style={{ flex: 'none' }}>
          <Toggle label="Review handovers" checked={on} disabled={busy}
            onChange={(next) => (next ? askTurnOn() : void save({ review_mode: 'off' }))} />
        </div>
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); saveLimit(); }}
        style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '14px 0 0' }}
      >
        <label htmlFor="review-limit" style={{ fontSize: 14, fontWeight: 600, flex: '1 1 160px' }}>Monthly limit</label>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span aria-hidden="true" style={{ color: 'var(--tx2)' }}>$</span>
          <input
            id="review-limit" className="wr-input" inputMode="decimal" type="number" min={1} max={MAX_LIMIT} step="any"
            value={draft} onChange={(e) => setDraft(e.target.value)} disabled={busy}
            aria-describedby="review-limit-help" style={{ width: 120, fontFamily: FONT_MONO }}
          />
        </span>
        <Button type="submit" size={28} busy={busy && !pending} busyLabel="Saving…" disabled={!draftValid || draftLimit === limit}>Save limit</Button>
        <p id="review-limit-help" style={{ flexBasis: '100%', margin: 0, fontSize: 12.5, color: 'var(--tx2)' }}>
          Counted on WhiteRoom’s list prices, separately from your agents’ spend caps. Reviews stop for the month when it’s reached.
        </p>
      </form>

      {busy && !pending && <p role="status" style={{ margin: '8px 0 0', fontSize: 12.5, color: 'var(--tx2)' }}>Saving…</p>}
      {spend && (
        <p role="status" style={{ margin: '12px 0 0', fontSize: 13, color: spend.warn ? 'var(--warn-tx)' : 'var(--tx2)' }}>{spend.text}</p>
      )}
      {note && <p role="alert" style={{ margin: '8px 0 0', fontSize: 12.5, color: 'var(--bad)' }}>{note}</p>}

      <ConfirmDialog
        open={!!pending}
        title={pending?.title ?? ''}
        body={pending?.body ?? ''}
        confirmLabel={pending?.confirm ?? ''}
        cancelLabel={pending?.cancel}
        tone="neutral"
        busy={busy}
        onConfirm={() => { if (pending) void save(pending.patch); }}
        onCancel={() => setPending(null)}
      />
    </Panel>
  );
}
