// Naming agents: the setup recipes send the agent header, and a call refused
// for not naming its agent reads in plain words with WhiteRoom as the subject.

import { describe, it, expect } from 'vitest';
import { eventModel } from '@/lib/activity';
import { activityRow } from '@/lib/home';
import {
  AGENT_HEADER,
  AGENT_NAME_LINES,
  AGENT_PLACEHOLDER,
  UNNAMED_CALLS_REFUSED,
  agentNameLine,
  unnamedCallsRefused,
} from '@/lib/setup';
import type { AuditEntry } from '@/lib/whiteroom/types';

describe('setup recipes name the agent', () => {
  it('every naming line sends the agent header with the placeholder name', () => {
    expect(AGENT_HEADER).toBe('x-whiteroom-agent');
    for (const line of Object.values(AGENT_NAME_LINES)) {
      expect(line).toContain(AGENT_HEADER);
      expect(line).toContain(AGENT_PLACEHOLDER);
    }
  });

  it('uses each client’s own way of setting a header', () => {
    expect(AGENT_NAME_LINES.anthropic).toMatch(/^anthropic\.Anthropic\(default_headers=\{"x-whiteroom-agent": "my-agent"\}\)$/);
    expect(AGENT_NAME_LINES.openai).toMatch(/^OpenAI\(default_headers=\{"x-whiteroom-agent": "my-agent"\}\)$/);
    expect(AGENT_NAME_LINES.claudeCode).toMatch(/^export ANTHROPIC_CUSTOM_HEADERS="x-whiteroom-agent: my-agent"/);
  });

  it('picks the line for the connected provider; Azure uses the OpenAI SDK', () => {
    expect(agentNameLine('anthropic')).toBe(AGENT_NAME_LINES.anthropic);
    expect(agentNameLine('openai')).toBe(AGENT_NAME_LINES.openai);
    expect(agentNameLine('azure-openai')).toBe(AGENT_NAME_LINES.openai);
  });
});

describe('the unnamed-call warning', () => {
  it('reads the same everywhere, naming the control when asked', () => {
    expect(UNNAMED_CALLS_REFUSED).toBe('While this is on, calls that don’t name their agent are refused across this fleet.');
    expect(unnamedCallsRefused('Enforce')).toBe('While Enforce is on, calls that don’t name their agent are refused across this fleet.');
  });
});

describe('a refused unnamed call in Activity', () => {
  const e = { id: 'e1', timestamp: '2026-10-12T10:00:00.000Z', type: 'unnamed_call_refused' } as AuditEntry;

  it('is a fleet-level refusal with WhiteRoom as the subject', () => {
    const m = eventModel(e);
    expect(m.who).toBe('WhiteRoom');
    expect(m.said).toBe("refused a call that didn't name its agent (controls are active on this fleet)");
    expect(m.tone).toBe('block');
    const row = activityRow(e);
    expect(row.text).toBe("WhiteRoom refused a call that didn't name its agent (controls are active on this fleet)");
    expect(row.tag).toEqual({ label: 'Refused', tone: 'muted' });
  });
});
