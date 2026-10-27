// Naming agents: the setup recipes can send the agent header, and a call
// refused for not naming its agent reads in plain words, as WhiteRoom.

import { describe, it, expect } from 'vitest';
import { eventModel } from '@/lib/activity';
import { activityRow } from '@/lib/home';
import { ROUTES } from '@/lib/routes';
import {
  AGENT_HEADER,
  AGENT_HEADER_LINE,
  AGENT_NAME_LINES,
  AGENT_NAME_WHY,
  AGENT_PLACEHOLDER,
  AGENT_PY_HEADERS,
  UNNAMED_CALLS_ENFORCE,
  UNNAMED_CALLS_REFUSED,
} from '@/lib/setup';
import type { AuditEntry } from '@/lib/whiteroom/types';

describe('setup recipes name the agent', () => {
  it('leads with the header itself', () => {
    expect(AGENT_HEADER).toBe('x-whiteroom-agent');
    expect(AGENT_HEADER_LINE).toBe(`${AGENT_HEADER}: ${AGENT_PLACEHOLDER}`);
  });

  it('every example sends the header with the placeholder name', () => {
    const lines = [
      ...Object.values(AGENT_NAME_LINES.python),
      ...Object.values(AGENT_NAME_LINES.typescript),
      AGENT_NAME_LINES.claudeCode,
      AGENT_PY_HEADERS,
    ];
    for (const line of lines) {
      expect(line).toContain(AGENT_HEADER);
      expect(line).toContain(AGENT_PLACEHOLDER);
    }
  });

  it('uses each client’s own way of setting a header', () => {
    expect(AGENT_NAME_LINES.python.anthropic).toContain('anthropic.Anthropic(default_headers=');
    expect(AGENT_NAME_LINES.python.openai).toContain('openai.OpenAI(default_headers=');
    expect(AGENT_NAME_LINES.typescript.anthropic).toContain('new Anthropic({ defaultHeaders:');
    expect(AGENT_NAME_LINES.typescript.openai).toContain('new OpenAI({ defaultHeaders:');
    expect(AGENT_NAME_LINES.claudeCode).toContain('ANTHROPIC_CUSTOM_HEADERS');
    expect(AGENT_NAME_LINES.claudeCode).not.toContain('#');
  });

  it('says naming is automatic for agents with a system prompt', () => {
    expect(AGENT_NAME_WHY).toMatch(/system prompt/);
    expect(AGENT_NAME_WHY).toMatch(/automatically/);
  });
});

describe('the unnamed-call warnings', () => {
  it('say such calls are refused across the fleet', () => {
    for (const line of [UNNAMED_CALLS_REFUSED, UNNAMED_CALLS_ENFORCE]) {
      expect(line).toMatch(/refused/);
      expect(line).toMatch(/fleet/);
    }
    expect(UNNAMED_CALLS_ENFORCE).toMatch(/Block-mode rule/);
  });
});

describe('a refused unnamed call in Activity', () => {
  const e = { id: 'e1', timestamp: '2026-10-12T10:00:00.000Z', type: 'unnamed_call_refused' } as AuditEntry;

  it('is a fleet-level warning from WhiteRoom that links to setup', () => {
    const m = eventModel(e);
    expect(m.who).toBe('WhiteRoom');
    expect(m.said).toMatch(/^refused calls/);
    expect(m.said).toMatch(/identify/);
    expect(m.said).not.toContain("'");
    expect(m.tone).toBe('wouldBlock');
    expect(m.link?.href).toBe(ROUTES.fleetKey);
    const row = activityRow(e);
    expect(row.text.startsWith('WhiteRoom refused calls')).toBe(true);
    expect(row.tag).toEqual({ label: 'Refused', tone: 'warn' });
  });
});
