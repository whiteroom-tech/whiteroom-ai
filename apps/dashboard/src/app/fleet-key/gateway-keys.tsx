'use client';

// Gateway signing keys (signed agent names spec, section 7): for agents
// behind one gateway. The gateway signs each agent's name with a private key
// it keeps; the owner pastes the public key here. Only public keys are sent:
// pasted text holding a private key is caught here and never leaves the page.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, FONT_MONO } from '@whiteroom/ui';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { ConfirmDialog } from '@/components/citadel/ConfirmDialog';
import { ControlDeniedError, changeFailureText, gatewayKeyAdd, gatewayKeyRevoke, gatewayKeysGet } from '@/lib/whiteroom/client';
import type { FleetAuth, GatewayKey } from '@/lib/whiteroom/client';
import { fmtDay, timeAgo } from '@/lib/format';
import { CLI_VERSION } from '@/lib/sandbox/practice/model';

/** Makes a gateway's key pair, with the CLI release the dashboard names everywhere. */
export const GATEWAY_KEY_COMMAND = `npx @whiteroom-ai/cli@${CLI_VERSION} gateway-key new`;

/** What the paste box says before anything is sent; null when the text may go to the engine. */
export function pastedKeyProblem(text: string): string | null {
  // A raw 32-byte private key looks like a public one; a PEM's header doesn't.
  return /PRIVATE KEY/i.test(text) ? 'That’s a private key. Don’t share it. Make a new pair.' : null;
}

/** "Added Nov 25 · Last used 2 min ago", or "Never used". */
export function gatewayKeyLine(k: GatewayKey, now = Date.now()): string {
  return `Added ${fmtDay(k.addedAt, now)} · ${k.lastUsedAt ? `Last used ${timeAgo(k.lastUsedAt, now)}` : 'Never used'}`;
}

export function GatewayKeysCard({ apiKey, fleetId, fleetToken, preview }: {
  apiKey: string; fleetId: string; fleetToken: string | null;
  /** /dev/fleet-key: sample keys, and nothing is fetched or changed. */
  preview?: GatewayKey[];
}) {
  const auth = useMemo<FleetAuth>(() => ({ apiKey, fleetId, fleetToken }), [apiKey, fleetId, fleetToken]);
  const [keys, setKeys] = useState<GatewayKey[] | null>(preview ?? null);
  const [max, setMax] = useState(2);
  const [loadError, setLoadError] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState<GatewayKey | null>(null);
  // The key being revoked now, so its own button says so.
  const [revokingKid, setRevokingKid] = useState<string | null>(null);
  // A refused change (not the owner): the list stays, the controls go.
  const [readOnly, setReadOnly] = useState(false);

  const refresh = useCallback(async () => {
    const res = await gatewayKeysGet(auth);
    setKeys(res.keys);
    setMax(res.max);
    setLoadError(false);
  }, [auth]);

  useEffect(() => {
    if (preview) return;
    refresh().catch(() => { setLoadError(true); setKeys([]); });
  }, [refresh, preview]);

  /** The change was saved; only the list didn't reload. */
  async function refreshAfterChange() {
    try {
      await refresh();
    } catch {
      setError('Saved. Reload the page to see the list.');
    }
  }

  function refused(e: unknown, fallback: string) {
    if (e instanceof ControlDeniedError) setReadOnly(true);
    setError(changeFailureText(e, fallback));
  }

  async function add() {
    const problem = pastedKeyProblem(text);
    if (problem) { setError(problem); return; }
    if (preview) { setError('Keys can’t be added in the preview.'); return; }
    setBusy(true); setError('');
    try {
      await gatewayKeyAdd(auth, text.trim());
    } catch (e) {
      refused(e, 'The key wasn’t added. Try again in a minute.');
      setBusy(false);
      return;
    }
    setText('');
    await refreshAfterChange();
    setBusy(false);
  }

  async function revoke(k: GatewayKey) {
    if (preview) return;
    setBusy(true); setRevokingKid(k.kid); setError('');
    try {
      await gatewayKeyRevoke(auth, k.kid);
    } catch (e) {
      refused(e, 'The key wasn’t revoked. Try again in a minute.');
      setBusy(false); setRevokingKid(null);
      return;
    }
    await refreshAfterChange();
    setBusy(false); setRevokingKid(null);
  }

  const full = (keys?.length ?? 0) >= max;
  const pasted = pastedKeyProblem(text);

  return (
    <SettingsCard id="gateway-keys" anchor title="Gateway signing keys" sub="For agents behind one gateway: it signs each agent’s name, so they don’t each need a key.">
      <div className="wr-gw">
        {keys === null ? (
          <p className="wr-gw__note">Loading gateway keys&hellip;</p>
        ) : loadError ? (
          <p className="wr-gw__note">Gateway keys couldn’t be loaded. Reload the page to try again.</p>
        ) : keys.length === 0 ? (
          <p className="wr-gw__note">No gateway keys yet. Make one with <code style={{ fontFamily: FONT_MONO }}>{GATEWAY_KEY_COMMAND}</code>, then paste the public key here.</p>
        ) : (
          <ul className="wr-gw__list">
            {keys.map((k) => (
              <li key={k.kid} className="wr-gw__row">
                <span className="wr-gw__kid" style={{ fontFamily: FONT_MONO }}>{k.kid}</span>
                <span className="wr-gw__when">{gatewayKeyLine(k)}</span>
                {!readOnly && <Button variant="danger" size={28} className="wr-btn--outline-bad wr-gw__revoke" busy={revokingKid === k.kid} busyLabel="Revoking…" disabled={busy} onClick={() => setRevoking(k)}>Revoke</Button>}
              </li>
            ))}
          </ul>
        )}

        {keys !== null && !loadError && !readOnly && (full ? (
          <p className="wr-gw__note">You can have {max} keys. Revoke one first.</p>
        ) : (
          <div className="wr-gw__add">
            <label htmlFor="gateway-key-text" className="wr-gw__label">Public key (Ed25519)</label>
            <textarea
              id="gateway-key-text"
              className="wr-input wr-gw__text"
              rows={3}
              spellCheck={false}
              autoComplete="off"
              value={text}
              onChange={(e) => { setText(e.target.value); setError(''); }}
              placeholder="-----BEGIN PUBLIC KEY-----"
              aria-invalid={!!(pasted || error) || undefined}
              aria-describedby={error || pasted ? 'gateway-key-error' : undefined}
            />
            <div>
              <Button size={28} onClick={() => void add()} busy={busy} busyLabel="Adding…" disabled={!text.trim() || !!pasted}>Add key</Button>
            </div>
          </div>
        ))}
        {(pasted || error) && <p id="gateway-key-error" role="alert" className="wr-gw__error">{pasted ?? error}</p>}
      </div>

      <ConfirmDialog
        open={revoking !== null}
        title={revoking ? `Revoke key ${revoking.kid.slice(0, 8)}…?` : ''}
        body={<>Names it signs stop counting at once. In Enforce, those calls are refused.</>}
        confirmLabel="Revoke"
        busy={busy}
        onConfirm={() => { const k = revoking; setRevoking(null); if (k) void revoke(k); }}
        onCancel={() => setRevoking(null)}
      />
    </SettingsCard>
  );
}
