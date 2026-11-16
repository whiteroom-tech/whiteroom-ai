/**
 * A request body, or null once it passes `maxBytes` or can't be read (the
 * client went away mid-send). Stops reading at the limit instead of buffering
 * the rest, so a limit checked after `req.text()` or `req.arrayBuffer()`
 * (which read everything first) isn't the only bound.
 */
export async function readCapped(req: Request, maxBytes: number): Promise<Uint8Array | null> {
  if (Number(req.headers.get('content-length') ?? 0) > maxBytes) return null;
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}
