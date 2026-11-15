// Data protection phase 3 (D5): "Where tools can send data" (send_limit) on
// Controls: its sentence and row, the typed-domain refusals, the Seen list
// helpers, Save asking "weaker?" only in Enforce, and a hidden list never
// written back.
import { describe, expect, it } from 'vitest';
import {
  agentGets, canAddSeen, domainAllows, domainProblem, domainRefusal, domainsHidden, draftChanges, draftFrom, draftProblem, emptyPick, offeredTemplates,
  looksLikeSender, responseChoices, ruleConditionText, ruleSentenceText, seenFullLine, seenNotOnList, sendLookingTools, toolsWithNoDomain, weakenings,
} from '@/lib/controls-view';
import { canAct } from '@/lib/controls-guard';
import { engineTakes, RULE_CATEGORY, RULE_LABELS } from '@/lib/governance';
import { undoFor } from '@/lib/rule-history';
import type { GovernanceHistoryEntry, GovernanceRule, SendLimitParams, SendSeenRow } from '@/lib/whiteroom/types';

const send = (params: Partial<SendLimitParams> = {}, rest: Partial<GovernanceRule> = {}): GovernanceRule => ({
  id: 's1', fleetId: 'f', ruleType: 'send_limit', mode: 'watch', response: 'notify', appliesTo: 'all', version: 1, changedBy: 't', changedAt: '2026-11-15T00:00:00Z',
  params: { tools: ['send_email', 'http_request'], domains: ['acme.com'], ...params }, ...rest,
});
const row = (domain: string, tool = 'send_email', extra: Partial<SendSeenRow> = {}): SendSeenRow => ({ tool, domain, agentId: 'support-agent', firstSeen: '2026-11-12T10:00:00Z', ...extra });

describe('Where tools can send data: names and sentences', () => {
  it('is a data protection rule named with the word data', () => {
    expect(RULE_LABELS.send_limit).toBe('Where tools can send data');
    expect(RULE_CATEGORY.send_limit).toBe('Data protection');
  });

  it('reads as its tools and the list, in the row and in a sentence', () => {
    expect(ruleConditionText(send())).toBe('send_email or http_request sends to a domain that isn’t on the list');
    expect(ruleConditionText(send({ tools: ['send_email'] }))).toBe('send_email sends to a domain that isn’t on the list');
    expect(ruleConditionText(send({ tools: ['a', 'b', 'c'] }))).toBe('One of 3 tools sends to a domain that isn’t on the list');
    expect(ruleConditionText(send({ tools: [] }))).toBe('No tools picked yet');
    expect(ruleSentenceText(send())).toBe('When send_email or http_request sends to a domain that isn’t on the list, it would alert you.');
    expect(ruleSentenceText({ ...send(), mode: 'enforce', response: 'block' })).toBe('When send_email or http_request sends to a domain that isn’t on the list, block the call.');
  });

  it('needs a tool to do anything; an empty list is a real rule', () => {
    expect(emptyPick(send({ tools: [] }))).toBe('a tool');
    expect(emptyPick(send({ domains: [] }))).toBeNull();
    expect(canAct({ ...send({ domains: [] }), mode: 'enforce', response: 'block' })).toBe(true);
    expect(canAct({ ...send({ tools: [] }), mode: 'enforce', response: 'block' })).toBe(false);
    expect(canAct({ ...send(), mode: 'enforce', response: 'notify' })).toBe(false);
    expect(draftProblem({ ...draftFrom(send({ tools: [] })), mode: 'enforce' })).toBe('Pick at least one tool before you turn on Enforce.');
    // Over the engine's limits, Save says so in any mode, before the round trip.
    expect(draftProblem(draftFrom(send({ tools: Array.from({ length: 51 }, (_, i) => `t${i}`) })))).toBe('A rule holds up to 50 tools. Remove one to save.');
    expect(draftProblem(draftFrom(send({ domains: Array.from({ length: 101 }, (_, i) => `d${i}.com`) })))).toBe('A rule allows up to 100 domains. Remove one to save.');
  });

  it('only alerts or blocks, Only alert me first, on any fleet', () => {
    expect(responseChoices(true, 'send_limit', 'notify')).toEqual(['notify', 'block']);
    expect(responseChoices(false, 'send_limit', 'notify')).toEqual(['notify', 'block']);
  });

  it('tells the agent only that a data rule blocked it: no list, no limit', () => {
    const body = agentGets({ ...send(), response: 'block' });
    expect(body).toContain('message: A data rule blocked this call.');
    expect(body).toContain('reason: destination_not_allowed');
    expect(body).toContain('resets: never');
    expect(body).not.toMatch(/acme\.com|limit|current/);
  });
});

describe('Add a rule offers it only when the engine takes it', () => {
  it('follows governance_list ruleTypes, and an engine that doesn’t say gets the first six', () => {
    const types = (ruleTypes?: string[]) => offeredTemplates(ruleTypes).map((t) => t.type);
    expect(types(undefined)).toEqual(['spend_cap', 'call_rate', 'model_allowlist', 'loop_breaker', 'tool_list', 'keyword']);
    expect(types(['spend_cap', 'loop_breaker', 'model_allowlist', 'tool_list', 'call_rate', 'keyword'])).not.toContain('send_limit');
    expect(types(['spend_cap', 'loop_breaker', 'model_allowlist', 'tool_list', 'call_rate', 'keyword', 'send_limit'])).toContain('send_limit');
    expect(engineTakes('send_limit', undefined)).toBe(false);
    const entry = offeredTemplates(['send_limit']).find((t) => t.type === 'send_limit')!;
    expect(entry.title).toBe('Limit where tools can send data');
    expect(entry.desc).toBe('For example, email only to your own domain.');
  });
});

describe('likely senders', () => {
  it('match whole name parts like send, post, http, email or upload', () => {
    for (const t of ['send_email', 'post_message', 'http_request', 'uploadFile', 'Email-Customer', 'SEND']) expect(looksLikeSender(t), t).toBe(true);
    for (const t of ['postgres_query', 'resend_count', 'search_docs', 'emailer_config', 'httpx']) expect(looksLikeSender(t), t).toBe(false);
    expect(sendLookingTools(['search_docs', 'send_email', 'delete_record', 'http_request'])).toEqual(['send_email', 'http_request']);
    expect(sendLookingTools(Array.from({ length: 60 }, (_, i) => `send_${i}`))).toHaveLength(50);
  });
});

describe('a typed allowed domain', () => {
  it('is refused in plain words for a scheme, port, path, *, @, %, an IP address or a repeat', () => {
    const list = ['acme.com'];
    expect(domainProblem('https://acme.io', list)).toBe('Type just the domain, like acme.com, without https://.');
    expect(domainProblem('acme.io:443', list)).toBe('Leave out the port. Type just the domain, like acme.com.');
    expect(domainProblem('acme.io/path', list)).toBe('Leave out the path. Type just the domain, like acme.com.');
    expect(domainProblem('*.acme.io', list)).toBe('Leave out the *. acme.com already covers mail.acme.com.');
    expect(domainProblem('bob@acme.io', list)).toBe('Type the domain, not an address: acme.com, not bob@acme.com.');
    expect(domainProblem('acme%2eio', list)).toBe('A domain can’t have a % in it.');
    expect(domainProblem('10.0.0.1', list)).toBe('Use a domain name, not an IP address.');
    expect(domainProblem('[::1]', list)).toBe('Use a domain name, not an IP address.');
    for (const ip of ['2130706433', '0x7f.1', '1.2.3', '127.1', '0x7f000001', '10.0.0.1.']) expect(domainProblem(ip, list), ip).toBe('Use a domain name, not an IP address.');
    expect(domainProblem('ACME.com.', list)).toBe('That domain is already on the list.');
    expect(domainProblem('a b.com', list)).toBe('That isn’t a domain. Type one like acme.com.');
  });

  it('is fine as a plain domain, a subdomain, a host with no public ending, or an IDN', () => {
    for (const d of ['acme.io', 'mail.acme.io', 'db.internal', 'localhost', 'bücher.de', ' Acme.IO ']) expect(domainProblem(d, ['acme.com']), d).toBeNull();
  });

  it('stops at 100', () => {
    const full = Array.from({ length: 100 }, (_, i) => `d${i}.com`);
    expect(domainProblem('new.com', full)).toBe('A rule allows up to 100 domains. Remove one to add another.');
  });

  it('turns the engine’s entry refusals into the same words, and keeps any other reason as it is', () => {
    // The engine's own words (E7 ENTRY_REFUSALS), entry first.
    expect(domainRefusal('"co.uk": that ending is shared by many sites. Enter a domain under it.')).toBe('“co.uk”: That ending is shared by many sites, like co.uk. Type the full domain, like acme.co.uk.');
    expect(domainRefusal('"https://x.io": enter just the domain, without http:// or the like.')).toBe('“https://x.io”: Type just the domain, like acme.com, without https://.');
    expect(domainRefusal('"x.io:25": enter the domain without a port.')).toBe('“x.io:25”: Leave out the port. Type just the domain, like acme.com.');
    expect(domainRefusal('"x.io/a": enter the domain without a path.')).toBe('“x.io/a”: Leave out the path. Type just the domain, like acme.com.');
    expect(domainRefusal('"*.x.io": enter the domain without *. A domain already covers the names under it.')).toBe('“*.x.io”: Leave out the *. acme.com already covers mail.acme.com.');
    expect(domainRefusal('"a@x.io": enter a domain, not an email address.')).toBe('“a@x.io”: Type the domain, not an address: acme.com, not bob@acme.com.');
    expect(domainRefusal('"10.0.0.1": enter a domain, not an IP address.')).toBe('“10.0.0.1”: Use a domain name, not an IP address.');
    expect(domainRefusal('"a b": that isn\'t a domain.')).toBe('“a b”: That isn’t a domain. Type one like acme.com.');
    // Anything else keeps its words, even when it mentions a port, a path, an IP or an address.
    for (const other of ['You can have up to 50 rules for all agents.', 'The port 443 path is busy; try again.', 'domains can hold at most 100 entries.', '"x": something else about an IP address.', 'This rule\'s domains are hidden here, so its settings can\'t be saved from here.']) {
      expect(domainRefusal(other), other).toBe(other);
    }
  });
});

describe('Seen, not on the list', () => {
  it('covers subdomains of an entry, never a lookalike', () => {
    expect(domainAllows('acme.com', 'mail.acme.com')).toBe(true);
    expect(domainAllows('acme.com', 'acme.com.evil.com')).toBe(false);
    expect(domainAllows('acme.com', 'notacme.com')).toBe(false);
  });

  it('never offers Add to list on a reserved or cleaned row', () => {
    expect(canAddSeen(row('gmail.com'))).toBe(true);
    expect(canAddSeen(row('(none)'))).toBe(false);
    expect(canAddSeen(row('(unreadable)'))).toBe(false);
    expect(canAddSeen(row('[cleaned].example', 'send_email', { canAdd: false }))).toBe(false);
  });

  it('drops the rows a staged list now allows, keeping the reserved ones', () => {
    const rows = [row('gmail.com'), row('sendgrid.net', 'http_request'), row('(none)', 'post_message')];
    expect(seenNotOnList(rows, ['acme.com', 'gmail.com']).map((r) => r.domain)).toEqual(['sendgrid.net', '(none)']);
  });

  it('names a listed tool with no readable domain, and only a listed one', () => {
    const rows = [row('(none)', 'post_message'), row('(none)', 'post_message'), row('(none)', 'old_tool'), row('gmail.com')];
    expect(toolsWithNoDomain(rows, ['send_email', 'post_message'])).toEqual(['post_message']);
    expect(toolsWithNoDomain([], ['post_message'])).toEqual([]);
  });

  it('says when it is full', () => {
    expect(seenFullLine({ rows: [], full: true })).toBe('More than 500 domains seen. Showing the first 500.');
    // The engine's flag decides: exactly 500 rows with full false isn't "more than 500".
    expect(seenFullLine({ rows: Array.from({ length: 500 }), full: false })).toBeNull();
    expect(seenFullLine({ rows: Array.from({ length: 500 }) })).toBe('More than 500 domains seen. Showing the first 500.');
    expect(seenFullLine({ rows: [], fleetFull: true })).toBe('Your fleet has seen too many domains to list more. New ones aren’t shown.');
    expect(seenFullLine({ rows: [row('gmail.com')] })).toBeNull();
  });
});

describe('Save on a Where tools can send data rule', () => {
  it('asks "weaker?" for a domain added in Enforce, never in Watch', () => {
    const watch = send();
    expect(weakenings(watch, { ...watch, params: { ...watch.params, domains: ['acme.com', 'gmail.com'] } })).toEqual([]);
    const enforce = send({}, { mode: 'enforce', response: 'block' });
    expect(weakenings(enforce, { ...enforce, params: { ...enforce.params, domains: ['acme.com', 'gmail.com'] } })).toEqual(['Also allows gmail.com']);
    expect(weakenings(enforce, { ...enforce, params: { ...enforce.params, tools: ['send_email'] } })).toEqual(['No longer checks http_request']);
    // A stricter list asks nothing.
    expect(weakenings(enforce, { ...enforce, params: { ...enforce.params, domains: [] } })).toEqual([]);
  });

  it('never writes a hidden list back for a caller without the secret (domainCount)', () => {
    const hidden = send({ domains: [], domainCount: 3 });
    expect(domainsHidden(hidden)).toBe(true);
    expect(domainsHidden(send())).toBe(false);
    const d = draftFrom(hidden);
    // Whatever the draft holds, Save sends no params over a hidden list.
    const changes = draftChanges({ ...d, mode: 'enforce', params: { tools: ['send_email'], domains: [] } }, hidden);
    expect(changes).toEqual({ mode: 'enforce' });
    expect(draftChanges({ ...d, params: { tools: ['x'], domains: [] } }, hidden)).toBeNull();
  });

  it('offers no undo that would write a hidden list back', () => {
    const snap = (domains: string[], domainCount?: number) => ({ mode: 'watch' as const, response: 'notify' as const, appliesTo: 'all' as const, params: { tools: ['send_email'], domains, ...(domainCount !== undefined && { domainCount }) } });
    const entry = (before: ReturnType<typeof snap>, after: ReturnType<typeof snap> | null): GovernanceHistoryEntry => ({ id: 'h1', ruleId: 's1', ruleType: 'send_limit', description: 'Settings updated', by: 'u', time: '2026-11-14T00:00:00Z', before, after });
    const shown = send({ tools: ['send_email'], domains: [], domainCount: 2 });
    expect(undoFor(entry(snap([], 1), snap([], 2)), [shown])).toBeNull();
    expect(undoFor(entry(snap([], 2), null), [])).toBeNull();
    // With the list, an undo is offered as for any rule.
    expect(undoFor(entry(snap(['acme.com']), snap(['acme.com', 'gmail.com'])), [send({ tools: ['send_email'], domains: ['acme.com', 'gmail.com'] })])).toMatchObject({ kind: 'update' });
  });
});
