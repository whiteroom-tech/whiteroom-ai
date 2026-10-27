// @vitest-environment happy-dom
// saveBlob: a temporary link named for the file is clicked while in the page,
// then removed; its object URL is revoked only after REVOKE_AFTER_MS.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REVOKE_AFTER_MS, saveBlob } from '@/lib/download';

describe('saveBlob', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('clicks a temporary link for the file, removes it, and frees the URL later', () => {
    vi.useFakeTimers();
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:file-1');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    let clicked: { href: string; download: string; inPage: boolean } | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked = { href: this.href, download: this.download, inPage: document.body.contains(this) };
    });
    const blob = new Blob(['{}'], { type: 'application/json' });

    saveBlob(blob, 'audit.json');

    expect(create).toHaveBeenCalledWith(blob);
    expect(clicked).toEqual({ href: 'blob:file-1', download: 'audit.json', inPage: true });
    expect(document.querySelector('a[download]')).toBeNull();
    vi.advanceTimersByTime(REVOKE_AFTER_MS - 1);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(revoke).toHaveBeenCalledWith('blob:file-1');
  });
});
