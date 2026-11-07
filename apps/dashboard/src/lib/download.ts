/** How long a saved file's temporary link lives: long enough that a large file isn't cut off. */
export const REVOKE_AFTER_MS = 30_000;

/** Saves a Blob as a file download through a temporary link. Browser only. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  // In the document while it's clicked, which some browsers need.
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
}
