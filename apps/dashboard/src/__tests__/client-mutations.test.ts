// Audit F12: mutations that the engine refused — by HTTP status or by a
// 200 carrying {error} / {success:false} — were reported to operators as
// done. They must reject so the UI keeps the draft and shows the failure.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ControlDeniedError, controlFailure, isAuthError, pauseAgent, resumeAgent, updateAgentTaskType } from '@/lib/whiteroom/client';

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

// A control refusal from the BFF (not the owner, not signed in) is a 403, but
// the session is fine: treating it as an auth error signed people out.
describe('control refusals', () => {
  it('throw ControlDeniedError with the server’s reason, which isn’t an auth error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Only this fleet’s owner can change its rules or pause its agents.', code: 'control_denied' }, 403));
    const e = await pauseAgent('f', 'a', 'sk-key').catch((x) => x);
    expect(e).toBeInstanceOf(ControlDeniedError);
    expect(e.message).toMatch(/Only this fleet’s owner/);
    expect(isAuthError(e)).toBe(false);
  });

  it('leave a plain 403 as an auth error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Unauthorized' }, 403));
    const e = await pauseAgent('f', 'a', 'sk-key').catch((x) => x);
    expect(e).not.toBeInstanceOf(ControlDeniedError);
    expect(isAuthError(e)).toBe(true);
  });
});

describe('controlFailure', () => {
  it('maps each failure to how the page reacts', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Only this fleet’s owner can change its rules or pause its agents.', code: 'control_denied' }, 403));
    expect(controlFailure(await resumeAgent('f', 'a', 'sk-key').catch((x) => x))).toBe('refused');
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Unauthorized' }, 401));
    expect(controlFailure(await resumeAgent('f', 'a', 'sk-key').catch((x) => x))).toBe('sign-out');
    fetchMock.mockResolvedValue(jsonResponse({ success: false, error: 'Agent is in mandatory rest' }));
    expect(controlFailure(await resumeAgent('f', 'a', 'sk-key').catch((x) => x))).toBe('failed');
  });

  it('keeps a 403 with a non-JSON body an auth error', async () => {
    fetchMock.mockResolvedValue(new Response('<html>Forbidden</html>', { status: 403 }));
    const e = await pauseAgent('f', 'a', 'sk-key').catch((x) => x);
    expect(e).not.toBeInstanceOf(ControlDeniedError);
    expect(controlFailure(e)).toBe('sign-out');
  });
});
