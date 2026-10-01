// Pure logic behind check-colors.mjs, kept separate so it can be tested.

// A hex color or a color function. The lookbehind skips HTML entities
// (`&#8594;`) and anything glued to a word.
const COLOR = /(?<![\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b|\b(?:rgba?|hsla?)\(/g;

// A line opts out with this marker and a reason, for colors that must not
// follow the theme (another company's logo). A bare marker doesn't count.
export const ALLOW = /color-literal-ok:\s*\S/;

/**
 * Raw color literals on one line.
 * - An in-page anchor (`href="#add"`) isn't a color.
 * - In CSS, `#fee` before a declaration's colon is an id selector, not a color.
 */
export function findColors(line, { css = false } = {}) {
  if (ALLOW.test(line)) return [];
  const out = [];
  for (const m of line.matchAll(COLOR)) {
    const before = line.slice(0, m.index);
    if (m[0].startsWith('#')) {
      if (/(?:href|to|hash)\s*=\s*\{?\s*["'`]$/.test(before)) continue;
      if (css) {
        // Within a declaration there's a colon after the last { or ;
        const decl = before.slice(Math.max(before.lastIndexOf('{'), before.lastIndexOf(';')) + 1);
        if (!decl.includes(':')) continue;
      }
    }
    out.push(m[0]);
  }
  return out;
}

/**
 * Whether --update may write `counts` over the saved baseline.
 * `old` is null only when there is no baseline file yet (bootstrap). An empty
 * baseline {} is a real one: every file must stay at zero.
 */
export function canUpdate(old, counts) {
  if (old === null) return { ok: true, grew: [] };
  const grew = Object.entries(counts).filter(([f, n]) => n > (old[f] ?? 0));
  return { ok: grew.length === 0, grew };
}

/** Files over their baseline, and files now under it. */
export function compare(baseline, counts) {
  const over = Object.entries(counts).filter(([f, n]) => n > (baseline[f] ?? 0)).map(([f]) => f);
  const lowered = Object.entries(baseline).filter(([f, n]) => (counts[f] ?? 0) < n).map(([f]) => f);
  return { over, lowered };
}
