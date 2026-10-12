// Fleet key page, Bedrock follow-ups: switching provider tab starts the
// add-key form over, and the Claude Code naming line is left out for Bedrock
// keys. Rendered statically, like the other component tests here.

import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentNaming } from '@/components/citadel/AgentNaming';
import { EMPTY_KEY_FORM, agentNamingFor, keyFormReducer } from '@/lib/provider-key-form';
import type { KeyFormAction, KeyFormState } from '@/lib/provider-key-form';

const run = (actions: KeyFormAction[], from: KeyFormState = EMPTY_KEY_FORM) => actions.reduce(keyFormReducer, from);

describe('add-key form across provider tabs', () => {
  it('clears the key, second field and message when the tab changes', () => {
    const typed = run([
      { type: 'edit', field: 'value', text: 'azurekeyexample0000' },
      { type: 'edit', field: 'endpoint', text: 'https://acme.openai.azure.com' },
      { type: 'error', msg: 'Endpoint must be your Azure resource URL.' },
    ]);
    expect(typed).toMatchObject({ value: 'azurekeyexample0000', endpoint: 'https://acme.openai.azure.com', status: 'error' });
    expect(keyFormReducer(typed, { type: 'tab' })).toEqual({ value: '', endpoint: '', status: 'idle', msg: '' });
  });

  it('keeps what was typed while editing, and clears it once connected or cancelled', () => {
    const typed = run([
      { type: 'edit', field: 'value', text: 'ABSKexample' },
      { type: 'edit', field: 'endpoint', text: 'us-east-1' },
    ]);
    expect(typed).toMatchObject({ value: 'ABSKexample', endpoint: 'us-east-1', status: 'idle' });
    expect(run([{ type: 'saving' }, { type: 'connected' }], typed)).toMatchObject({ value: '', endpoint: '', status: 'idle' });
    expect(keyFormReducer(typed, { type: 'cancel' })).toMatchObject({ value: '', endpoint: '' });
  });

  it('typing after an error clears the error state', () => {
    const errored = run([{ type: 'error', msg: 'nope' }]);
    expect(keyFormReducer(errored, { type: 'edit', field: 'value', text: 'x' }).status).toBe('idle');
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
