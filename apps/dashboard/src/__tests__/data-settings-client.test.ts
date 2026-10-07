// Settings › Data and privacy talks to the engine through these two calls.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ControlDeniedError, dataSettingsGet, dataSettingsSet } from '@/lib/whiteroom/client';

const fetchMock = vi.fn();
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('data settings client', () => {
  it('reads the fleet settings', async () => {
    const s = { handover_persistence: true, content_capture: false, personal_data: 'keep' };
    fetchMock.mockResolvedValue(jsonResponse(s));
    await expect(dataSettingsGet('f')).resolves.toEqual(s);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ action: 'fleet_data_settings_get', fleet_id: 'f' });
  });

  it('returns null from an engine without the action, so the section hides', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Unknown action: fleet_data_settings_get' }, 400));
    await expect(dataSettingsGet('f')).resolves.toBeNull();
  });

  it('sends the patch, and rejects a refused or unapplied change', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true, handover_persistence: false, content_capture: true, personal_data: 'keep' }));
    await expect(dataSettingsSet('f', { handover_persistence: false })).resolves.toMatchObject({ handover_persistence: false });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ action: 'fleet_data_settings_set', fleet_id: 'f', handover_persistence: false });
    fetchMock.mockResolvedValue(jsonResponse({ success: false, error: 'The setting is saved, but deleting what was stored didn’t finish. Try again.' }));
    await expect(dataSettingsSet('f', { content_capture: false })).rejects.toThrow('didn’t finish');
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Only the fleet owner can change this.', code: 'control_denied' }, 403));
    await expect(dataSettingsSet('f', { content_capture: false })).rejects.toBeInstanceOf(ControlDeniedError);
  });
});
