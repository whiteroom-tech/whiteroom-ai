// Audit F12: mutations that the engine refused — by HTTP status or by a
// 200 carrying {error} / {success:false} — were reported to operators as
// done. They must reject so the UI keeps the draft and shows the failure.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pauseAgent, resumeAgent, updateAgentTaskType } from '@/lib/whiteroom/client';

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mutation results', () => {
  it('rejects an HTTP failure', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'boom' }, 500));
    await expect(updateAgentTaskType('f', 'a', 'drafting', 'sk-key')).rejects.toThrow('HTTP 500');
  });

  it('rejects a 200 that carries an error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "Agent 'a' not found." }));
    await expect(updateAgentTaskType('f', 'a', 'drafting', 'sk-key')).rejects.toThrow("Agent 'a' not found.");
  });

  it('rejects a refused pause or resume', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: false, error: 'Agent is in mandatory rest' }));
    await expect(resumeAgent('f', 'a', 'sk-key')).rejects.toThrow('mandatory rest');
    fetchMock.mockResolvedValue(jsonResponse({ success: false }));
    await expect(pauseAgent('f', 'a', 'sk-key')).rejects.toThrow();
  });

  it('resolves a confirmed change', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true }));
    await expect(pauseAgent('f', 'a', 'sk-key')).resolves.toEqual({ success: true });
  });
});
