// @vitest-environment happy-dom
// Home › Check audit trail: the check runs on open, a late answer from an
// earlier opening is ignored, a failed extent read still shows the result,
// an expired session signs out, other failures say so, Download proof waits
// for a result, and the preview fetches nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import './support/dialog';

const api = vi.hoisted(() => ({ verify: vi.fn(), integrity: vi.fn() }));
vi.mock('@/lib/whiteroom/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/whiteroom/client')>()),
  verifyAudit: api.verify,
  auditIntegrity: api.integrity,
}));
const { AuditCheckDialog } = await import('@/components/home/AuditCheckDialog');
const { WhiteRoomApiError } = await import('@/lib/whiteroom/client');

const OK = { valid: true, complete: true, eventsVerified: 12, message: '' };
const INFO = { fleetId: 'f1', mode: 'sequenced', headSeq: 12, verifiedThroughSeq: 12, verifiedAt: null, prunedBeforeTracking: false, legacyEvents: 0, gaps: { count: 0, recent: [] }, anchoring: { enabled: false } };

let el: HTMLDivElement;
let root: Root;
beforeEach(() => { el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el); });
afterEach(() => { act(() => root.unmount()); el.remove(); api.verify.mockReset(); api.integrity.mockReset(); });
const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
const show = async (props: Record<string, unknown>) => { await act(async () => { root.render(h(AuditCheckDialog, { open: true, fleetId: 'f1', onClose: () => {}, ...props })); }); await flush(); };
const proof = () => [...el.querySelectorAll('button')].find((b) => b.textContent === 'Download proof') as HTMLButtonElement;

describe('Home audit check dialog', () => {
  it('runs the check on open, and Download proof waits for the result', async () => {
    let answer: (v: unknown) => void = () => {};
    api.verify.mockReturnValue(new Promise((r) => { answer = r; }));
    api.integrity.mockResolvedValue(INFO);
    await show({});
    expect(api.verify).toHaveBeenCalledWith('f1', undefined);
    expect(el.textContent).toContain('Checking your audit trail…');
    expect(proof().disabled).toBe(true);
    await act(async () => { answer(OK); });
    await flush();
    expect(el.textContent).toContain('Nothing changed or missing');
    expect(proof().disabled).toBe(false);
  });

  it('still shows the result when the extent read fails', async () => {
    api.verify.mockResolvedValue(OK);
    api.integrity.mockRejectedValue(new Error('down'));
    await show({});
    expect(el.textContent).toContain('All 12 events verified.');
  });

  it('ignores a late answer from an earlier opening', async () => {
    let first: (v: unknown) => void = () => {};
    api.verify.mockReturnValueOnce(new Promise((r) => { first = r; })).mockResolvedValueOnce({ valid: false, eventsVerified: 3, message: 'Event 4 was changed.' });
    api.integrity.mockResolvedValue(INFO);
    await show({});
    await show({ open: false });
    await show({});
    expect(el.textContent).toContain('Event 4 was changed.');
    await act(async () => { first(OK); });
    await flush();
    expect(el.textContent).toContain('Event 4 was changed.');
    expect(el.textContent).not.toContain('Nothing changed or missing');
  });

  it('signs out on an expired session, and says when the check didn’t run', async () => {
    const onAuthError = vi.fn();
    api.verify.mockRejectedValue(new WhiteRoomApiError('expired', 401));
    await show({ onAuthError });
    expect(onAuthError).toHaveBeenCalled();
    await show({ open: false });
    api.verify.mockRejectedValue(new Error('down'));
    await show({ onAuthError });
    expect(el.textContent).toContain('The check didn’t run.');
  });

  it('fetches nothing in the preview', async () => {
    await show({ preview: { result: OK, info: INFO } });
    expect(api.verify).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Nothing changed or missing');
  });
});
