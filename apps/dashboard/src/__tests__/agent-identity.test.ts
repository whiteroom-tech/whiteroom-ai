import { describe, expect, it } from 'vitest';
import { agentDisplay, cleanAgentName, credentialWords, identityLines, identityWords, percentText, MAX_AGENT_NAME } from '@/lib/agent-identity';

describe('identity words (gap-closing spec 0.2)', () => {
  it('render every value in the table', () => {
    expect(identityWords('bound_key', 'explicit')).toBe('Own key');
    expect(identityWords('fleet_key', 'explicit')).toBe('Shared key, name sent by the agent');
    expect(identityWords('fleet_key', 'inferred')).toBe('Shared key, name worked out by WhiteRoom');
    expect(identityWords('none', 'explicit')).toBe('Provider key, name sent by the agent');
    expect(identityWords('none', 'inferred')).toBe('Provider key, name worked out by WhiteRoom');
    expect(identityWords('session', 'explicit')).toBe('AWS session, name sent by the agent');
    expect(identityWords('session', 'inferred')).toBe('AWS session, name worked out by WhiteRoom');
    for (const c of ['bound_key', 'fleet_key', 'none', 'session'] as const) expect(identityWords(c, 'unresolved')).toBe('Not known');
    expect(identityWords('not_recorded', 'explicit')).toBe('Not recorded');
    expect(identityWords('not_recorded', 'unresolved')).toBe('Not recorded');
    // Signed agent names: the words don't change with how the name was found.
    for (const n of ['explicit', 'inferred', 'unresolved'] as const) {
      expect(identityWords('signed_name', n)).toBe('Signed by your gateway');
      expect(identityWords('signature_invalid', n)).toBe('Gateway signature didn\'t match');
      expect(identityWords('other', n)).toBe('Other');
    }
  });

  it('turn rows into lines, most calls first, with their share', () => {
    const lines = identityLines([
      { credential: 'fleet_key', nameSource: 'inferred', calls: 1, lastAt: null },
      { credential: 'bound_key', nameSource: 'explicit', calls: 299, lastAt: null },
    ]);
    expect(lines.map((l) => [l.words, percentText(l)])).toEqual([['Own key', '99%'], ['Shared key, name worked out by WhiteRoom', '<1%']]);
    expect(identityLines([])).toEqual([]);
  });

  it('merge rows with the same words', () => {
    const lines = identityLines([
      { credential: 'fleet_key', nameSource: 'unresolved', calls: 2, lastAt: null },
      { credential: 'none', nameSource: 'unresolved', calls: 2, lastAt: null },
    ]);
    expect(lines).toEqual([{ words: 'Not known', calls: 4, percent: 100 }]);
  });

  it('name each unbound credential', () => {
    expect(['fleet_key', 'none', 'session', 'not_recorded', 'signature_invalid', 'other'].map((c) => credentialWords(c as never)))
      .toEqual(['Shared key', 'Provider key', 'AWS session', 'Not recorded', 'Gateway signature didn\'t match', 'Other']);
  });
});

describe('display names', () => {
  it('are cleaned as the engine cleans them; empty clears', () => {
    expect(cleanAgentName('  Billing   bot ')).toEqual({ name: 'Billing bot' });
    expect(cleanAgentName('   ')).toEqual({ name: null });
    expect(cleanAgentName('a​b')).toHaveProperty('error');
    expect(cleanAgentName('x'.repeat(MAX_AGENT_NAME + 1))).toHaveProperty('error');
  });

  it('show with the id beside them, or the id alone', () => {
    expect(agentDisplay('a1', { a1: 'Billing bot' })).toEqual({ name: 'Billing bot', id: 'a1' });
    expect(agentDisplay('a1', { a1: 'a1' })).toEqual({ name: null, id: 'a1' });
    expect(agentDisplay('a1', null)).toEqual({ name: null, id: 'a1' });
  });
});
