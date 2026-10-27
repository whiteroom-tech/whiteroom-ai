// @vitest-environment happy-dom
// Runs' dialogs: what Check audit trail says for each result of the chain
// check, the check running on open (a late answer from an earlier opening is
// ignored), and Export runs handing back the chosen days and agent.
import './support/dialog';
import { describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import type { AuditIntegrity, VerifyAuditResult } from '@/lib/whiteroom/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.hoisted(() => ({ verify: vi.fn(), integrity: vi.fn() }));
vi.mock('@/lib/whiteroom/client', async (orig) => ({ ...(await orig<typeof import('@/lib/whiteroom/client')>()), verifyAudit: api.verify, auditIntegrity: api.integrity }));
const { auditCheckText, AuditCheckDialog, ExportRunsDialog } = await import('@/components/runs/RunsDialogs');
const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });

const info = (x: Partial<AuditIntegrity> = {}): AuditIntegrity => ({
  fleetId: 'f', mode: 'sequenced', headSeq: 2045, verifiedThroughSeq: 939, verifiedAt: null, prunedBeforeTracking: true, legacyEvents: 0,
  gaps: { count: 0, recent: [] }, anchoring: { enabled: false }, ...x,
});

describe('audit check wording', () => {
  it('says nothing changed or missing only for a whole check with no recorded gaps', () => {
    expect(auditCheckText({ valid: true, complete: true, eventsVerified: 2045, message: '' }, info({ verifiedThroughSeq: 2045 }))).toEqual({
      tone: 'ok', title: 'Nothing changed or missing', detail: 'All 2,045 events verified. Events before tracking started aren’t covered.',
    });
    expect(auditCheckText({ valid: true, eventsVerified: 2045, message: '' }, info({ verifiedThroughSeq: 2045, gaps: { count: 2, recent: [] }, prunedBeforeTracking: false })))
      .toEqual({ tone: 'neutral', title: 'Nothing changed', detail: 'All 2,045 events verified. 2 recorded gaps where events may be missing.' });
  });
  it('says only what a partial check covered', () => {
    // An explicit "not complete" wins over an extent read separately.
    expect(auditCheckText({ valid: true, complete: false, eventsVerified: 2045, message: '' }, info({ verifiedThroughSeq: 2045 })).tone).toBe('neutral');
    expect(auditCheckText({ valid: true, eventsVerified: 939, message: '' }, info())).toEqual({
      tone: 'neutral', title: 'Nothing changed in the events checked', detail: 'Verified through event 939 of 2,045. Events before tracking started aren’t covered. The rest hasn’t been checked yet.',
    });
  });
  it('names a problem, and never passes a partial check', () => {
    expect(auditCheckText({ valid: false, eventsVerified: 10, message: 'Event 11 was changed.' }, null)).toEqual({ tone: 'bad', title: 'A problem was found', detail: 'Event 11 was changed.' });
    expect(auditCheckText({ valid: null, eventsVerified: 500, message: '' }, null).tone).toBe('neutral');
    expect(auditCheckText({ valid: true, complete: false, eventsVerified: 500, message: '' }, info()).tone).toBe('neutral');
    // Without the trail's extent, no green tick.
    expect(auditCheckText({ valid: true, eventsVerified: 500, message: '' }, null)).toMatchObject({ tone: 'neutral', title: 'Nothing changed in the events checked' });
  });
});

async function mount(node: React.ReactElement) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(node); });
  await flush();
  return { el, root, render: (n: React.ReactElement) => act(async () => { root.render(n); }) };
}

describe('Check audit trail dialog', () => {
  const ok: VerifyAuditResult = { valid: true, complete: true, eventsVerified: 2045, message: '' };
  it('runs the check when opened and shows what it found', async () => {
    api.verify.mockResolvedValue(ok);
    api.integrity.mockResolvedValue(info());
    const props = { fleetId: 'f1', onClose: () => {}, onDownloaded: () => {} };
    const m = await mount(h(AuditCheckDialog, { ...props, open: false }));
    await m.render(h(AuditCheckDialog, { ...props, open: true }));
    await flush();
    expect(api.verify).toHaveBeenCalledWith('f1', undefined);
    expect(m.el.textContent).toContain('Nothing changed or missing');
    expect(m.el.textContent).toContain('not yet anchored outside WhiteRoom');
    m.root.unmount();
  });
  it('ignores a late answer from an earlier opening, and says when the check failed', async () => {
    let first: (r: VerifyAuditResult) => void = () => {};
    api.verify.mockImplementationOnce(() => new Promise((res) => { first = res; })).mockRejectedValueOnce(new Error('503'));
    api.integrity.mockResolvedValue(info());
    const props = { fleetId: 'f1', onClose: () => {}, onDownloaded: () => {} };
    const m = await mount(h(AuditCheckDialog, { ...props, open: false }));
    await m.render(h(AuditCheckDialog, { ...props, open: true }));
    await act(async () => { ([...m.el.querySelectorAll('button')].find((b) => b.textContent === 'Done') as HTMLElement).click(); });
    await m.render(h(AuditCheckDialog, { ...props, open: false }));
    await m.render(h(AuditCheckDialog, { ...props, open: true }));
    await flush();
    expect(m.el.textContent).toContain('The check didn’t run.');
    await act(async () => { first(ok); });
    await flush();
    expect(m.el.textContent).toContain('The check didn’t run.');
    m.root.unmount();
  });
});

describe('Export runs dialog', () => {
  it('offers what’s shown first when given, else the last 7 days, and hands back days and agent', async () => {
    const onDownload = vi.fn();
    const props = { agents: ['lead-agent', 'scout'], initialAgent: 'all', busy: false, error: null, onDownload, onCancel: () => {} };
    const m = await mount(h(ExportRunsDialog, { ...props, open: false }));
    await m.render(h(ExportRunsDialog, { ...props, open: true }));
    expect((m.el.querySelector('input[value="7d"]') as HTMLInputElement).checked).toBe(true);
    expect(m.el.textContent).not.toContain('What’s shown now');
    await act(async () => { (m.el.querySelector('input[value="yesterday"]') as HTMLInputElement).click(); });
    const select = m.el.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, 'scout');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => { ([...m.el.querySelectorAll('button')].find((b) => b.textContent === 'Download .xlsx') as HTMLElement).click(); });
    expect(onDownload).toHaveBeenCalledWith({ span: 'yesterday', agent: 'scout' });
    await m.render(h(ExportRunsDialog, { ...props, open: false }));
    await m.render(h(ExportRunsDialog, { ...props, open: true, shown: 'Sat, Oct 24' }));
    expect((m.el.querySelector('input[value="shown"]') as HTMLInputElement).checked).toBe(true);
    expect(m.el.textContent).toContain('Sat, Oct 24');
    m.root.unmount();
  });
});
