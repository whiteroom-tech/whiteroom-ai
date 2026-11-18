// "Data deletion" (data_deletion) on Controls: its names and sentences, "Not
// set up" with no tools, the same actions as Block tools, the likely tools
// picked, and what a change that checks less says.
import { describe, expect, it } from 'vitest';
import {
  agentGets, blocksWhen, commandLookingTools, draftFrom, draftProblem, emptyPick, looksLikeCommandRunner, notSetUp, offeredTemplates,
  responseChoices, ruleConditionText, ruleSentenceText, weakenings, whenSentence,
} from '@/lib/controls-view';
import { canAct } from '@/lib/controls-guard';
import { reasonText } from '@/lib/runs';
import type { DataDeletionParams, GovernanceRule } from '@/lib/whiteroom/types';

const deletion = (params: Partial<DataDeletionParams> = {}, rest: Partial<GovernanceRule> = {}): GovernanceRule => ({
  id: 'd1', fleetId: 'f', ruleType: 'data_deletion', mode: 'watch', response: 'block', appliesTo: 'all', version: 1, changedBy: 't', changedAt: '2026-11-17T00:00:00Z',
  params: { commandTools: ['run_sql', 'bash', 'psql_exec'], ...params }, ...rest,
});

describe('Data deletion: names and sentences', () => {
  it('says what it catches in the row, under When and in full, and "would" until it is enforced', () => {
    expect(ruleConditionText(deletion())).toBe('A delete command on 3 tools');
    expect(ruleConditionText(deletion({ commandTools: ['bash'] }))).toBe('A delete command on 1 tool');
    const w = whenSentence(deletion());
    expect(w.pre + w.val + w.post).toBe('Is asked to run a delete command with run_sql, bash, psql_exec');
    expect(ruleSentenceText(deletion())).toBe('When an agent is asked to run a command that deletes from a database or a cloud account, it would block the call.');
    expect(ruleSentenceText(deletion({}, { mode: 'enforce', response: 'pause' }))).toBe('When an agent is asked to run a command that deletes from a database or a cloud account, pause the agent.');
  });

  it('names its reason in plain words', () => {
    expect(reasonText('data_deletion')).toBe('a command that deletes data');
  });

  it('is offered with the other data rules, only when the engine takes it', () => {
    expect(offeredTemplates(['data_deletion']).map((t) => [t.title, t.desc])).toEqual([['Stop agents deleting data', 'For example, a dropped table or an emptied storage bucket.']]);
    expect(offeredTemplates(undefined).some((t) => t.type === 'data_deletion')).toBe(false);
    expect(offeredTemplates(['tool_list', 'keyword']).some((t) => t.type === 'data_deletion')).toBe(false);
  });
});

describe('Not set up without tools', () => {
  it('needs a tool before it does anything, and before Enforce', () => {
    const empty = deletion({ commandTools: [] });
    expect(emptyPick(empty)).toBe('a tool');
    expect(notSetUp(empty)).toBe(true);
    expect(ruleConditionText(empty)).toBe('No tools picked yet');
    expect(ruleSentenceText(empty)).toBe('No tools picked yet.');
    expect(draftProblem(draftFrom(empty))).toBeNull();
    expect(draftProblem({ ...draftFrom(empty), mode: 'enforce' })).toBe('Pick at least one tool before you turn on Enforce.');
    expect(canAct({ ...empty, mode: 'enforce' })).toBe(false);
  });

  it('holds up to 50 tools', () => {
    const many = Array.from({ length: 51 }, (_, i) => `t${i}`);
    expect(draftProblem(draftFrom(deletion({ commandTools: many })))).toBe('A rule holds up to 50 tools. Remove one to save.');
    expect(draftProblem(draftFrom(deletion({ commandTools: many.slice(0, 50) })))).toBeNull();
  });
});

describe('The same actions as Tool list', () => {
  it('offers Block, Pause, Stop and Only alert me', () => {
    expect(responseChoices(true, 'data_deletion')).toEqual(responseChoices(true, 'tool_list'));
    expect(responseChoices(true, 'data_deletion')).toEqual(['block', 'pause', 'stop', 'notify']);
  });

  it('can stop a call only in Enforce with an action that stops one', () => {
    expect(canAct(deletion())).toBe(false);
    expect(canAct(deletion({}, { mode: 'enforce', response: 'notify' }))).toBe(false);
    expect(canAct(deletion({}, { mode: 'enforce', response: 'block' }))).toBe(true);
  });

  it('says when it blocks, for the box naming the one rule that does', () => {
    expect(blocksWhen(deletion({}, { appliesTo: ['db-agent'] }))).toBe('only for delete commands on the tools it names, for db-agent');
  });

  it('tells the agent which tool and what kind of delete, never the command', () => {
    expect(agentGets(deletion({}, { response: 'block' }))).toBe('403 governance_block\nmessage: <tool> was asked to <kind of delete>. Choose a step that can be undone, or ask a person.\nresponse: block\nreason: data_deletion\nretryable: false\nresets: never');
    // A held agent has no next step, so it isn't told to choose one.
    expect(agentGets(deletion({}, { response: 'stop' }))).toBe('403 governance_block\nmessage: <tool> was asked to <kind of delete>.\nresponse: stop\nreason: data_deletion\nretryable: false\nresets: when someone resumes it');
    expect(agentGets(deletion({}, { response: 'notify' }))).toBe('Nothing: the call goes through.\nYou get an alert; the agent doesn’t.');
  });
});

describe('The tools picked to start with', () => {
  it('are the ones named like a shell or a database, by a whole part of the name', () => {
    for (const t of ['run_sql', 'bash', 'bashTool', 'execute-command', 'db_query', 'shell', 'terminal_exec', 'runCmd']) expect(looksLikeCommandRunner(t), t).toBe(true);
    for (const t of ['shellfish_menu', 'send_email', 'read_file', 'executive_summary', 'queryable', 'dashboard']) expect(looksLikeCommandRunner(t), t).toBe(false);
  });

  it('as many as the rule holds', () => {
    expect(commandLookingTools(['read_file', 'run_sql', 'bash'])).toEqual(['run_sql', 'bash']);
    expect(commandLookingTools(Array.from({ length: 60 }, (_, i) => `sql_${i}`))).toHaveLength(50);
  });
});

describe('A change that checks less', () => {
  it('says which tools are no longer checked', () => {
    expect(weakenings(deletion(), deletion({ commandTools: ['bash'] }))).toContain('No longer checks run_sql, psql_exec');
    expect(weakenings(deletion(), deletion({ commandTools: ['run_sql', 'bash', 'psql_exec', 'mysql'] }))).toEqual([]);
  });
});
