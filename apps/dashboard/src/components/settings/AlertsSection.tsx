'use client';

import { useEffect, useState } from 'react';
import { Button, Panel, FONT_MONO } from '@whiteroom/ui';
import { alertsGet, alertsSetSlack, alertsTest, type AlertsStatus } from '@/lib/whiteroom/client';
import { useFleetAuth } from '@/hooks/useFleetAuth';

/**
 * Settings › Alerts (README › Screen 7, P2.7): the fleet's Slack webhook.
 * Slack has to accept a test message before it's saved; afterwards only its
 * last four characters are shown. Hidden on engines without alerts and when
 * no fleet is signed in.
 */
export function AlertsSection() {
  const { fleetId, status: authStatus } = useFleetAuth();
  const [status, setStatus] = useState<AlertsStatus | null>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | 'remove' | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setStatus(null);
    if (authStatus !== 'authenticated' || !fleetId) return;
    let live = true;
    alertsGet(fleetId).then((s) => { if (live) setStatus(s); }, () => {});
    return () => { live = false; };
  }, [fleetId, authStatus]);

  if (!fleetId || !status) return null;

  async function run(kind: 'save' | 'test' | 'remove', fn: () => Promise<unknown>, done: string) {
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

  return (
    <Panel title="Alerts">
      <p style={{ fontSize: 13, color: 'var(--tx2)', margin: '0 0 16px', maxWidth: '62ch' }}>
        A Slack message when a rule says Just tell me, or pauses or stops an agent. Each alert links to the run. For fleet {fleetId}.
      </p>
      {status.slack ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13 }}>Slack webhook ending <span style={{ fontFamily: FONT_MONO }}>…{status.slack.ending}</span></span>
          <Button size={28} busy={busy === 'test'} busyLabel="Sending…" onClick={() => void run('test', async () => { if (!(await alertsTest(fleetId))?.success) throw new Error('Slack didn’t accept the test message.'); }, 'Test message sent. Check the channel.')}>Send a test</Button>
          <Button variant="ghost" size={28} busy={busy === 'remove'} busyLabel="Removing…" onClick={() => void run('remove', async () => setStatus(await alertsSetSlack(fleetId, null)), 'Slack alerts are off.')}>Remove</Button>
        </div>
      ) : (
        <form
          style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}
          onSubmit={(e) => { e.preventDefault(); void run('save', async () => { setStatus(await alertsSetSlack(fleetId, url.trim())); setUrl(''); }, 'Connected. A test message is in the channel.'); }}
        >
          <input
            type="url" className="wr-input" style={{ flex: '1 1 320px' }} required
            aria-label="Slack incoming webhook URL" placeholder="https://hooks.slack.com/services/…"
            value={url} onChange={(e) => setUrl(e.target.value)}
          />
          <Button type="submit" variant="primary" busy={busy === 'save'} busyLabel="Checking…">Connect Slack</Button>
        </form>
      )}
      {note && <p role="status" style={{ margin: '10px 0 0', fontSize: 12.5, color: note.ok ? 'var(--ok)' : 'var(--bad)' }}>{note.text}</p>}
    </Panel>
  );
}
