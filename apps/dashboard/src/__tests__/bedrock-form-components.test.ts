// Fleet key page, Bedrock follow-ups: the add-key form's state (remounted per
// provider tab), and the Claude Code naming line is left out for Bedrock
// keys. Rendered statically, like the other component tests here.

import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentNaming } from '@/components/citadel/AgentNaming';
import { EMPTY_KEY_FORM, agentNamingFor, boundAgentError, canSubmitKey, keyFormReducer, keyFormRequest } from '@/lib/provider-key-form';
import type { KeyFormAction, KeyFormState } from '@/lib/provider-key-form';

const run = (actions: KeyFormAction[], from: KeyFormState = EMPTY_KEY_FORM) => actions.reduce(keyFormReducer, from);

describe('add-key form state', () => {
  // Switching provider tab remounts the form (key={tab}), so it starts here.
  it('starts empty', () => {
    expect(EMPTY_KEY_FORM).toEqual({ value: '', endpoint: '', agent: '', status: 'idle', msg: '' });
  });

  it('keeps an "Only for agent" name while editing, and clears it once connected', () => {
    const typed = run([{ type: 'edit', field: 'value', text: 'sk-ant-x' }, { type: 'edit', field: 'agent', text: 'billing agent' }]);
    expect(typed).toMatchObject({ agent: 'billing agent', status: 'idle' });
    expect(run([{ type: 'saving' }, { type: 'connected' }], typed).agent).toBe('');
  });

  it('keeps what was typed while editing, and clears it once connected', () => {
    const typed = run([
      { type: 'edit', field: 'value', text: 'ABSKexample' },
      { type: 'edit', field: 'endpoint', text: 'us-east-1' },
    ]);
    expect(typed).toMatchObject({ value: 'ABSKexample', endpoint: 'us-east-1', status: 'idle' });
    expect(run([{ type: 'saving' }, { type: 'connected' }], typed)).toMatchObject({ value: '', endpoint: '', status: 'idle' });
  });

  it('keeps the typed key after a refused connect, and typing clears the error state', () => {
    const errored = run([{ type: 'edit', field: 'value', text: 'k' }, { type: 'saving' }, { type: 'error', msg: 'nope' }]);
    expect(errored).toMatchObject({ value: 'k', status: 'error', msg: 'nope' });
    expect(keyFormReducer(errored, { type: 'edit', field: 'value', text: 'k2' }).status).toBe('idle');
  });
});

describe('while a key is saving', () => {
  const saving = run([{ type: 'edit', field: 'value', text: 'ABSKexample' }, { type: 'saving' }]);

  it('typing keeps the form saving, so Connect stays busy', () => {
    const edited = run([
      { type: 'edit', field: 'value', text: 'ABSKexample2' },
      { type: 'edit', field: 'endpoint', text: 'us-east-1' },
    ], saving);
    expect(edited.status).toBe('saving');
    expect(canSubmitKey(edited)).toBe(false);
  });

  it('refuses a second submit until the call settles', () => {
    expect(canSubmitKey(EMPTY_KEY_FORM)).toBe(true);
    expect(canSubmitKey(saving)).toBe(false);
    expect(keyFormReducer(saving, { type: 'saving' })).toBe(saving);
    expect(canSubmitKey(keyFormReducer(saving, { type: 'error', msg: 'nope' }))).toBe(true);
    expect(canSubmitKey(keyFormReducer(saving, { type: 'connected' }))).toBe(true);
  });
});

describe('Claude Code naming line', () => {
  const claudeCodeLine = 'Copy the Claude Code agent name line';
  const render = (provider: string) => renderToStaticMarkup(h(AgentNaming, agentNamingFor(provider)));

  it('is hidden for Bedrock keys, which still get the Anthropic SDK line', () => {
    expect(agentNamingFor('bedrock-mantle')).toEqual({ provider: 'anthropic', claudeCode: false });
    const html = render('bedrock-mantle');
    expect(html).not.toContain(claudeCodeLine);
    expect(html).toContain('Copy the Anthropic agent name line');
  });

  it('is shown for Anthropic keys', () => {
    expect(agentNamingFor('anthropic')).toEqual({ provider: 'anthropic', claudeCode: true });
    expect(render('anthropic')).toContain(claudeCodeLine);
  });

  it('is not shown for OpenAI-shaped keys, as before', () => {
    expect(render('azure-openai')).not.toContain(claudeCodeLine);
    expect(render('openai')).not.toContain(claudeCodeLine);
  });

  it('defaults to shown when the flag is not passed', () => {
    expect(renderToStaticMarkup(h(AgentNaming, {}))).toContain(claudeCodeLine);
    expect(renderToStaticMarkup(h(AgentNaming, { provider: 'anthropic' }))).toContain(claudeCodeLine);
  });
});

describe('what Connect sends', () => {
  const form = (agent: string) => ({ value: 'sk-ant-api03-example-key-1234', endpoint: '', agent });

  it('names no agent when the field is empty or blank', () => {
    for (const agent of ['', '   ']) {
      const check = keyFormRequest('anthropic', form(agent));
      expect(check.ok && check.request.boundAgent).toBeFalsy();
    }
  });

  it('sends the trimmed agent name', () => {
    const check = keyFormRequest('anthropic', form('  billing agent '));
    expect(check).toMatchObject({ ok: true, request: { boundAgent: 'billing agent' } });
  });

  it('refuses a name the engine would, before anything is sent', () => {
    for (const bad of ['__proto__', 'a'.repeat(129), 'tab\tname', 'evil\u202eagent']) {
      expect(boundAgentError(bad), bad).not.toBeNull();
      expect(keyFormRequest('anthropic', form(bad)).ok, bad).toBe(false);
    }
    expect(boundAgentError('Research Agent')).toBeNull();
  });
});
