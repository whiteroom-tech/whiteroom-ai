// A minimal .xlsx writer: stored (uncompressed) ZIP plus SpreadsheetML, enough
// for plain tables of text and numbers. No dependency, runs in the browser.

let crcTable: number[] | null = null;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStore(files: { name: string; bytes: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
  const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];
  const parts: Uint8Array[] = []; const central: Uint8Array[] = []; let offset = 0;
  files.forEach((f) => {
    const name = enc.encode(f.name); const data = f.bytes; const c = crc32(data);
    const local = ([] as number[]).concat(u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(c), u32(data.length), u32(data.length), u16(name.length), u16(0));
    parts.push(new Uint8Array(local), name, data);
    const cen = ([] as number[]).concat(u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(c), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset));
    central.push(new Uint8Array(cen), name);
    offset += local.length + name.length + data.length;
  });
  const cStart = offset; let cSize = 0; central.forEach((c) => (cSize += c.length));
  parts.push(...central);
  parts.push(new Uint8Array(([] as number[]).concat(u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(cSize), u32(cStart), u16(0))));
  const total = parts.reduce((s, p) => s + p.length, 0); const out = new Uint8Array(total); let p = 0;
  parts.forEach((part) => { out.set(part, p); p += part.length; }); return out;
}

function colLetter(i: number): string { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
const xesc = (s: unknown) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c] ?? c));

export type Cell = string | number | null | undefined;
export interface Sheet { name: string; header: string[]; rows: Cell[][] }

function sheetXml(sheet: Sheet): string {
  const rowXml = (cells: Cell[], r: number) => `<row r="${r}">` + cells.map((c, i) => {
    const ref = colLetter(i) + r;
    if (typeof c === 'number' && Number.isFinite(c)) return `<c r="${ref}"><v>${c}</v></c>`;
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xesc(c ?? '')}</t></is></c>`;
  }).join('') + '</row>';
  const rows = [rowXml(sheet.header, 1), ...sheet.rows.map((r, i) => rowXml(r, i + 2))].join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
}

/** A workbook with one worksheet per sheet, in order. */
export function buildWorkbook(sheets: Sheet[]): Uint8Array {
  const enc = new TextEncoder();
  const file = (name: string, str: string) => ({ name, bytes: enc.encode(str) });
  const n = sheets.map((_, i) => i + 1);
  return zipStore([
    file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' + n.map((i) => `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>'),
    file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    file('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + sheets.map((sh, i) => `<sheet name="${xesc(sh.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>'),
    file('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + n.map((i) => `<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i}.xml"/>`).join('') + '</Relationships>'),
    ...sheets.map((sh, i) => file(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sh))),
  ]);
}

/** Save a workbook as a file download. */
export function downloadWorkbook(bytes: Uint8Array, filename: string): void {
  const ab = new ArrayBuffer(bytes.byteLength); new Uint8Array(ab).set(bytes);
  const blob = new Blob([ab], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(a.href);
}
