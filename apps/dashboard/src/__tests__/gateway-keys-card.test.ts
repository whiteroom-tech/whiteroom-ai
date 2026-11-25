// Fleet key's Gateway signing keys card (signed agent names spec, section 7),
// rendered statically with sample keys, as the preview page shows them.
import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GatewayKeysCard, gatewayKeyLine, pastedKeyProblem } from '@/app/fleet-key/gateway-keys';

const NOW = Date.parse('2026-11-25T12:00:00Z');
const key = (kid: string, lastUsedAt: string | null) => ({ kid, addedAt: '2026-11-25T09:00:00Z', lastUsedAt });
const card = (keys: Parameters<typeof GatewayKeysCard>[0]['preview']) => renderToStaticMarkup(h(GatewayKeysCard, { apiKey: 'k', fleetId: 'f1', fleetToken: null, preview: keys }));

describe('gateway signing keys card', () => {
  it('explains itself, lands on #gateway-keys, and says how to make a first key', () => {
    const html = card([]);
    expect(html).toContain('id="gateway-keys"');
    expect(html).toContain('Gateway signing keys');
    expect(html).toContain('For agents behind one gateway: it signs each agent’s name, so they don’t each need a key.');
    expect(html).toContain('No gateway keys yet. Make one with <code');
    expect(html).toContain('npx @whiteroom-ai/cli@2.2.0 gateway-key new');
    expect(html).toContain('Public key (Ed25519)');
  });

  it('lists each key by kid with when it was added and last used, and Revoke', () => {
    expect(gatewayKeyLine(key('0000000000000a01', '2026-11-25T11:58:00Z'), NOW)).toBe('Added Nov 25 · Last used 2 min ago');
    expect(gatewayKeyLine(key('0000000000000a01', null), NOW)).toBe('Added Nov 25 · Never used');
    const html = card([key('0000000000000a01', null)]);
    expect(html).toContain('0000000000000a01');
    expect(html).toContain('Never used');
    expect(html).toMatch(/<button[^>]*>Revoke<\/button>/);
  });

  it('at the limit, asks to revoke one first instead of offering the paste box', () => {
    const html = card([key('0000000000000a01', null), key('0000000000000b02', null)]);
    expect(html).toContain('You can have 2 keys. Revoke one first.');
    expect(html).not.toContain('Public key (Ed25519)');
  });

  it('catches a pasted private key before anything is sent, whatever its case', () => {
    // Built here, so the repository's secret scan never sees a key-shaped block.
    const header = (kind: string) => ['-----BEGIN', kind, 'KEY-----'].join(' ');
    expect(pastedKeyProblem(`${header('PRIVATE')}\nplaceholder`)).toBe('That’s a private key. Don’t share it. Make a new pair.');
    expect(pastedKeyProblem(header('OPENSSH PRIVATE'))).not.toBeNull();
    expect(pastedKeyProblem(header('private').toLowerCase())).not.toBeNull();
    expect(pastedKeyProblem('-----BEGIN PUBLIC KEY-----\nMCowBQ\n-----END PUBLIC KEY-----')).toBeNull();
    expect(pastedKeyProblem('')).toBeNull();
  });
});
