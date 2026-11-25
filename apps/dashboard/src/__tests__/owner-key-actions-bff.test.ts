// @vitest-environment happy-dom
// Fleet key's owner actions go through the BFF, which checks the owner and
// adds the dashboard's service credential the engine requires: a key for one
// agent, a key on the engine's cloud identity, removing a key, and gateway
// signing keys. Sent straight to the engine they're refused (403). Everything
// else on the page still goes straight to the engine with the fleet's key.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteBedrockRole, deleteProviderKey, gatewayKeyAdd, gatewayKeyRevoke, listProviderKeys, storeProviderKey } from '@/lib/whiteroom/client';

const auth = { fleetId: 'f', apiKey: 'sk-wr-placeholder', fleetToken: 'wr_placeholder' };
const fetchMock = vi.fn();
const sent = () => {
  const [url, init] = fetchMock.mock.calls.at(-1)! as [string, RequestInit];
  const headers = new Headers(init.headers);
  return { url: String(url), viaBff: String(url) === '/api/fleet/engine', carriesKey: headers.has('authorization') || headers.has('x-api-key'), body: JSON.parse(String(init.body)) };
};

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ success: true, keys: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('owner key actions', () => {
  it('go through the BFF without the fleet key in the browser, naming the fleet', async () => {
    await storeProviderKey(auth, 'sk-ant-placeholder', undefined, undefined, 'billing');
    expect(sent()).toMatchObject({ viaBff: true, carriesKey: false, body: { action: 'store_key', bound_agent: 'billing', fleet_id: 'f' } });
    await storeProviderKey(auth, 'placeholder', undefined, ' Bedrock-SigV4 ');
    expect(sent()).toMatchObject({ viaBff: true, carriesKey: false });
    await storeProviderKey(auth, 'placeholder', 'https://example.invalid', 'foundry-entra');
    expect(sent()).toMatchObject({ viaBff: true, carriesKey: false });
    await deleteBedrockRole(auth);
    expect(sent()).toMatchObject({ viaBff: true, carriesKey: false, body: { action: 'delete_bedrock_role', fleet_id: 'f' } });
    await deleteProviderKey(auth, 'sk-wr-placeholder...');
    expect(sent()).toMatchObject({ viaBff: true, carriesKey: false, body: { action: 'delete_key', key_prefix: 'sk-wr-placeholder', fleet_id: 'f' } });
    await gatewayKeyAdd(auth, 'placeholder');
    expect(sent()).toMatchObject({ viaBff: true, carriesKey: false, body: { action: 'gateway_key_add', fleet_id: 'f' } });
    await gatewayKeyRevoke(auth, '0000000000000a01');
    expect(sent()).toMatchObject({ viaBff: true, carriesKey: false, body: { action: 'gateway_key_revoke', fleet_id: 'f' } });
  });

  it('leave everything else going straight to the engine with the fleet key', async () => {
    await storeProviderKey(auth, 'sk-ant-placeholder');
    expect(sent()).toMatchObject({ viaBff: false, carriesKey: true, body: { action: 'store_key' } });
    await storeProviderKey(auth, 'placeholder', 'https://example.invalid', 'azure-openai');
    expect(sent()).toMatchObject({ viaBff: false, carriesKey: true });
    await listProviderKeys(auth);
    expect(sent()).toMatchObject({ viaBff: false, carriesKey: true, body: { action: 'list_keys' } });
  });
});
