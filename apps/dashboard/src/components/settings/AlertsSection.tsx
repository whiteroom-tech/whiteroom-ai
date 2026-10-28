'use client';

import { useEffect, useState } from 'react';
import { Button, FONT_MONO } from '@whiteroom/ui';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { alertsGet, alertsSetSlack, alertsSetTeams, alertsTest, type AlertChannel, type AlertsStatus } from '@/lib/whiteroom/client';
import { useFleetAuth } from '@/hooks/useFleetAuth';

const CHANNELS: Record<AlertChannel, { name: string; short: string; label: string; placeholder: string; set: typeof alertsSetSlack }> = {
  slack: { name: 'Slack', short: 'Slack', label: 'Slack incoming webhook URL', placeholder: 'https://hooks.slack.com/services/…', set: alertsSetSlack },
  teams: { name: 'Microsoft Teams', short: 'Teams', label: 'Microsoft Teams webhook URL', placeholder: 'https://…logic.azure.com/workflows/…', set: alertsSetTeams },
};

/**
 * Settings › Alerts (README › Screen 7, P2.7; Teams: engine E5): the fleet's
 * Slack and Microsoft Teams webhooks. Each has to accept a test message
 * before it's saved; afterwards only its last four characters are shown.
 * Teams shows only on engines that have it. Hidden on engines without alerts
 * and when no fleet is signed in.
 */
export function AlertsSection({ preview }: { preview?: AlertsStatus } = {}) {
  const auth = useFleetAuth();
  // /dev/settings: sample channels, nothing fetched.
  const fleetId = preview ? 'preview' : auth.fleetId;
  const authStatus = auth.status;
  const [status, setStatus] = useState<AlertsStatus | null>(preview ?? null);

  useEffect(() => {
    if (preview) return;
    setStatus(null);
    if (authStatus !== 'authenticated' || !fleetId) return;
    let live = true;
    alertsGet(fleetId).then((s) => { if (live) setStatus(s); }, () => {});
    return () => { live = false; };
  }, [fleetId, authStatus, preview]);

  if (!fleetId || !status) return null;
  const channels: AlertChannel[] = status.teams === undefined ? ['slack'] : ['slack', 'teams'];

  return (
    <SettingsCard id="alerts" title="Alerts" sub={`A ${channels.length > 1 ? 'Slack or Teams' : 'Slack'} message when a rule alerts, pauses or stops an agent, or blocks a call you asked about. Each links to the run.`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {channels.map((c) => <ChannelRow key={`${fleetId}:${c}`} fleetId={fleetId} channel={c} ending={status[c]?.ending ?? null} onStatus={setStatus} preview={!!preview} />)}
      </div>
    </SettingsCard>
  );
}

function ChannelRow({ fleetId, channel, ending, onStatus, preview = false }: { fleetId: string; channel: AlertChannel; ending: string | null; onStatus: (s: AlertsStatus) => void; preview?: boolean }) {
  const c = CHANNELS[channel];
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | 'remove' | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  async function run(kind: 'save' | 'test' | 'remove', fn: () => Promise<unknown>, done: string) {
    // /dev/settings: nothing is sent.
    if (preview) { setNote({ ok: true, text: 'Preview: nothing was sent.' }); return; }
    setBusy(kind);
    setNote(null);
    try {
      await fn();
      setNote({ ok: true, text: done });
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : 'That didn’t work. Try again.' });
    } finally {
      setBusy(null);
    }
  }
  const apply = async (u: string | null) => { const s = await c.set(fleetId, u); if (s) onStatus(s); };

  return (
    <div className="wr-srow" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
      <strong style={{ fontWeight: 600 }}>{c.name}</strong>
      {ending ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 'var(--fs-sm)' }}>Webhook ending <span style={{ fontFamily: FONT_MONO }}>…{ending}</span></span>
          <Button size={28} busy={busy === 'test'} busyLabel="Sending…" onClick={() => void run('test', async () => { if (!(await alertsTest(fleetId, channel))?.success) throw new Error(`${c.name} didn’t accept the test message.`); }, 'Test message sent. Check the channel.')}>Send a test</Button>
          <Button variant="ghost" size={28} busy={busy === 'remove'} busyLabel="Removing…" onClick={() => void run('remove', () => apply(null), `${c.name} alerts are off.`)}>Remove</Button>
        </div>
      ) : (
        <form
          style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}
          onSubmit={(e) => { e.preventDefault(); void run('save', async () => { await apply(url.trim()); setUrl(''); }, 'Connected. A test message is in the channel.'); }}
        >
          <input
            type="url" className="wr-input" style={{ flex: '1 1 320px' }} required
            aria-label={c.label} placeholder={c.placeholder}
            value={url} onChange={(e) => setUrl(e.target.value)}
          />
          <Button type="submit" variant="primary" busy={busy === 'save'} busyLabel="Checking…">Connect {c.short}</Button>
        </form>
      )}
      {note && <p role="status" style={{ margin: 0, fontSize: 'var(--fs-sm)', color: note.ok ? 'var(--ok)' : 'var(--bad)' }}>{note.text}</p>}
    </div>
  );
}
