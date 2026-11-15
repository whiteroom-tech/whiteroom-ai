// Data protection phase 2 (D4): Keywords markers, the fleet's tools in the
// tool pickers (tools_seen) and "Block tools" starting with delete-looking
// tools picked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteLookingTools, isMarker, keywordsShort, markerShort, newMarker, ruleConditionText, ruleSentenceText, weakenings } from '@/lib/controls-view';
import { toolsSeen } from '@/lib/whiteroom/client';
import type { GovernanceRule, KeywordParams } from '@/lib/whiteroom/types';

const MARKER = 'wrmk3f9a1c07b2e4d8a6';
const kw = (keywords: string[], where: KeywordParams['where'] = 'incoming'): GovernanceRule => ({
  id: 'k1', fleetId: 'f', ruleType: 'keyword', mode: 'watch', response: 'block', appliesTo: 'all', version: 1, changedBy: 't', changedAt: '2026-11-14T00:00:00Z',
  params: { keywords, where, wholeWord: true },
});

describe('markers', () => {
  it('are wrmk and 16 lowercase hex characters, a new one each time', () => {
    const made = Array.from({ length: 200 }, newMarker);
    for (const m of made) expect(m).toMatch(/^wrmk[0-9a-f]{16}$/);
    expect(new Set(made).size).toBe(200);
    expect(isMarker(MARKER)).toBe(true);
    expect(isMarker('wrmk3f9a1c07b2e4d8a')).toBe(false);
    expect(isMarker('Project Falcon')).toBe(false);
  });

  it('show shortened to one line: first 8, an ellipsis, last 4', () => {
    expect(markerShort(MARKER)).toBe('wrmk3f9a…d8a6');
  });

  it('read as a count in the row and the sentence, never as their text', () => {
    expect(ruleConditionText(kw(['Project Falcon', MARKER]))).toBe('Incoming data contains "Project Falcon", 1 marker');
    expect(ruleConditionText(kw([MARKER, 'wrmk00000000000000ff']))).toBe('Incoming data contains 2 markers');
    expect(ruleSentenceText(kw([MARKER], 'replies'))).toBe('When a model reply contains 1 marker, it would block the call.');
    expect(keywordsShort(kw([MARKER]).params as KeywordParams)).toBe('1 marker');
    expect(keywordsShort(kw(['a', 'b', MARKER]).params as KeywordParams)).toBe('"a", "b" + 1 more');
    expect(keywordsShort(kw(['a', 'b', 'c']).params as KeywordParams)).toBe('"a", "b" + 1 more');
    expect(keywordsShort(kw([]).params as KeywordParams)).toBe('');
  });

  it('a removed marker reads as a count when Save asks before loosening the rule', () => {
    const before = kw(['Orion', MARKER, 'wrmk00000000000000ff']);
    expect(weakenings(before, kw(['Orion', 'wrmk00000000000000ff']))).toEqual(['No longer looks for 1 marker']);
    expect(weakenings(before, kw([]))).toEqual(['No longer looks for “Orion”, 2 markers']);
  });
});

// The engine refuses a keyword that "looks like a key or password": it runs
// each one through sanitize() and refuses any credential it finds
// (governance.ts validKeywordParams). The engine is a separate private repo,
// so its patterns are copied here from concepts/sanitize.ts (engine main
// 6dd80368). If the engine adds a pattern, add it here too.
describe('a marker passes the engine’s "looks like a credential" check', () => {
  const SECRET_NAMES = 'password|passwd|pwd|passphrase|secret|api[_-]?key|access[_-]?key|private[_-]?key|(?:access|refresh|auth|session|id|bearer)[_-]?token';
  const SECRET_LEAD = `\\\\?["']?(?:${SECRET_NAMES})\\\\?["']?\\s{0,3}[:=]\\s{0,3}`;
  const ENGINE_CREDENTIALS: RegExp[] = [
    /\bsk-(?:ant-[a-z0-9]{2,10}-|proj-|wr-)?[A-Za-z0-9_-]{16,256}/,
    /\bwr(?:x|_acct)?_[A-Za-z0-9-]{16,128}/,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
    /\bgh[pousr]_[A-Za-z0-9]{30,255}/,
    /\bxox[abprs]-[A-Za-z0-9-]{10,255}/,
    /\bAIza[0-9A-Za-z_-]{35}/,
    /\beyJ[A-Za-z0-9_-]{8,256}\.eyJ[A-Za-z0-9_-]{8,32768}\.[A-Za-z0-9_-]{8,2048}/,
    /\b(Bearer\s{1,4})([A-Za-z0-9._~+/=-]{12,4096})/i,
    /\b([a-z][a-z0-9+.-]{0,30}:\/\/)([^\s:@/]{1,256}):([^\s@/]{1,4096})@/i,
    new RegExp(`(${SECRET_LEAD}\\\\?")([^"\\\\\\n]{1,512})`, 'i'),
    new RegExp(`(${SECRET_LEAD}')([^'\\n]{1,512})`, 'i'),
    new RegExp(`(${SECRET_LEAD})([^\\s"',}{\\\\]{1,512})`, 'i'),
    /(\bAuthorization\\?"?\s{0,3}:\s{0,3}\\?"?(?:Basic|Digest|Token|Negotiate|NTLM)\s{1,4})([A-Za-z0-9+/=._~-]{4,4096})/i,
    /((?<![A-Za-z0-9_])token=)([^\s&#"',}{\\]{1,512})/i,
    /-----BEGIN [^-]*PRIVATE KEY-----/,
  ];
  const looksLikeCredential = (k: string) => ENGINE_CREDENTIALS.some((re) => re.test(k));

  it('the copied patterns catch what the engine refuses (placeholders, made up here)', () => {
    const a = (n: number) => 'a'.repeat(n);
    for (const fake of [
      `sk-${a(20)}`, `wr_${a(20)}`, `AKIA${'A'.repeat(16)}`, `ghp_${a(30)}`, `xoxb-${a(10)}`, `AIza${a(35)}`,
      `eyJ${a(8)}.eyJ${a(8)}.${a(8)}`, `Bearer ${a(12)}`, 'https://user:pass@example.test', 'password=x', 'api_key: "x"',
      "secret='x'", 'Authorization: Basic abcd', 'token=x', '-----BEGIN RSA PRIVATE KEY-----',
    ]) expect(looksLikeCredential(fake), fake).toBe(true);
  });

  it('accepts every generated marker', () => {
    for (let i = 0; i < 2000; i++) {
      const m = newMarker();
      expect(looksLikeCredential(m), m).toBe(false);
      // The engine's other limits on a keyword: 1–50 characters, one word.
      expect(m.length).toBeLessThanOrEqual(50);
    }
  });
});

describe('"Block tools" pre-pick', () => {
  it('picks tools with a name part like delete, remove, drop, purge, update or write, in any case, up to 100', () => {
    expect(deleteLookingTools(['search_claims', 'update_claim', 'DeleteAttachment', 'send_email', 'drop_table', 'purgeCache', 'remove_user', 'write_file', 'read_file']))
      .toEqual(['update_claim', 'DeleteAttachment', 'drop_table', 'purgeCache', 'remove_user', 'write_file']);
    expect(deleteLookingTools([])).toEqual([]);
    // Whole name parts, split at non-letters and camelCase: not words that only contain one.
    expect(deleteLookingTools(['delete_record', 'removeUser', 'bulk-update', 'records.deleted', 'XMLWrite', 'dropdown_options', 'overwrite_x', 'updater', 'droplet_list', 'writer_notes']))
      .toEqual(['delete_record', 'removeUser', 'bulk-update', 'records.deleted', 'XMLWrite']);
    expect(deleteLookingTools(Array.from({ length: 150 }, (_, i) => `delete_${i}`))).toHaveLength(100);
  });
});

describe('toolsSeen', () => {
  const fetchMock = vi.fn();
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('asks the engine for tools_seen on the fleet and returns its tools', async () => {
    fetchMock.mockResolvedValue(reply({ tools: ['update_claim', 'send_email', 'update_claim'] }));
    await expect(toolsSeen('f1', 'k')).resolves.toEqual(['update_claim', 'send_email']);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ action: 'tools_seen', fleet_id: 'f1' });
  });

  it('gives no tools for an engine without it or an odd reply, and throws on a failure so it can be asked again', async () => {
    fetchMock.mockResolvedValue(reply({ error: 'Unknown action: tools_seen' }, 400));
    await expect(toolsSeen('f1', 'k')).resolves.toEqual([]);
    fetchMock.mockResolvedValue(reply({ error: 'boom' }, 500));
    await expect(toolsSeen('f1', 'k')).rejects.toThrow();
    fetchMock.mockResolvedValue(reply({ error: 'not yours' }, 403));
    await expect(toolsSeen('f1', 'k')).rejects.toThrow();
    fetchMock.mockResolvedValue(reply({}));
    await expect(toolsSeen('f1', 'k')).resolves.toEqual([]);
    fetchMock.mockResolvedValue(reply({ tools: 'update_claim' }));
    await expect(toolsSeen('f1', 'k')).resolves.toEqual([]);
  });

  it('leaves out names the picker couldn’t add whole', async () => {
    fetchMock.mockResolvedValue(reply({ tools: ['ok_tool', 'x'.repeat(65), '', ' padded ', 7, null] }));
    await expect(toolsSeen('f1', 'k')).resolves.toEqual(['ok_tool']);
  });
});
