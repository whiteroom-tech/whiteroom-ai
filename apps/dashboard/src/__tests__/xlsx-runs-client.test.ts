import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildWorkbook } from '@/lib/xlsx';
import { listRuns, runDays } from '@/lib/whiteroom/client';

// The writer stores files uncompressed, so their XML is readable in the bytes.
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe('xlsx writer', () => {
  it('writes a valid stored ZIP with one worksheet per sheet', () => {
    const bytes = buildWorkbook([
      { name: 'Runs', header: ['Run', 'Calls'], rows: [['lead-agent~8', 12], ['a<b & "c"', null]] },
      { name: 'Two', header: ['x'], rows: [] },
    ]);
    expect(bytes[0]).toBe(0x50); expect(bytes[1]).toBe(0x4b); // "PK"
    const s = text(bytes);
    expect(s).toContain('<sheet name="Runs" sheetId="1" r:id="rId1"/><sheet name="Two" sheetId="2" r:id="rId2"/>');
    expect(s).toContain('/xl/worksheets/sheet2.xml');
    expect(s).toContain('<c r="B2"><v>12</v></c>');
    expect(s).toContain('a&lt;b &amp; &quot;c&quot;'); // escaped text
    expect(s).toContain('<c r="B3" t="inlineStr"><is><t xml:space="preserve"></t></is></c>'); // empty cell
  });

  it('writes non-finite numbers as text, not broken numeric cells', () => {
    const s = text(buildWorkbook([{ name: 'S', header: ['n'], rows: [[NaN], [Infinity]] }]));
    expect(s).not.toContain('<v>NaN</v>');
    expect(s).not.toContain('<v>Infinity</v>');
  });
});

describe('listRuns', () => {
  const fetchMock = vi.fn();
  beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); });
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  it('reports an engine without list_runs as unsupported, so Runs keeps the event feed', async () => {
    fetchMock.mockResolvedValue(reply({ error: 'Unknown action.' }, 400));
    expect(await listRuns('f', { fromDay: '2026-10-01', toDay: '2026-10-01' }, 'sk-key')).toEqual({ unsupported: true });
  });

  it('throws on other failures and returns the page otherwise', async () => {
    fetchMock.mockResolvedValue(reply({ error: 'from_day and to_day must be YYYY-MM-DD' }, 400));
    await expect(listRuns('f', { fromDay: 'x', toDay: 'y' }, 'sk-key')).rejects.toThrow('HTTP 400');
    fetchMock.mockResolvedValue(reply({ fleetId: 'f', runs: [], total: 0, cursor: null }));
    expect(await listRuns('f', { fromDay: '2026-10-01', toDay: '2026-10-01' }, 'sk-key')).toMatchObject({ total: 0 });
  });

  it('sends the viewer’s time zone with the days', async () => {
    vi.stubEnv('TZ', 'America/New_York');
    fetchMock.mockResolvedValue(reply({ fleetId: 'f', runs: [], total: 0, cursor: null }));
    await listRuns('f', { fromDay: '2026-10-01', toDay: '2026-10-01' }, 'sk-key');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ action: 'list_runs', tz: 'America/New_York' });
    vi.unstubAllEnvs();
  });

  it('asks run_days for the strip, and reports an engine without it', async () => {
    fetchMock.mockResolvedValueOnce(reply({ fleetId: 'f', days: [{ day: '2026-10-01', runs: 3 }] }));
    expect(await runDays('f', { fromDay: '2026-09-02', toDay: '2026-10-01', agentId: 'a' }, 'sk-key')).toMatchObject({ days: [{ day: '2026-10-01', runs: 3 }] });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ action: 'run_days', from_day: '2026-09-02', to_day: '2026-10-01', agent_id: 'a' });
    fetchMock.mockResolvedValueOnce(reply({ error: 'Unknown action.' }, 400));
    expect(await runDays('f', { fromDay: '2026-10-01', toDay: '2026-10-01' }, 'sk-key')).toEqual({ unsupported: true });
  });
});
