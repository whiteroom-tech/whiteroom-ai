import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Every font size goes through the rem tokens in globals.css (--fs-*), so the
// Text size setting (Default / Large / Larger) scales all of it and nothing is
// stuck at a fixed, too-small pixel size.
const ROOTS = [join(__dirname, '..'), join(__dirname, '../../../../packages/ui/src')];
// The WhiteRoom wordmark is a brand asset and keeps its fixed size.
// The phone tab bar's labels stay at 14px (--fs-xs at the default size): five
// must fit a 320px phone, and its icons carry them at a larger Text size.
const ALLOWED = new Set(['components/citadel/FleetLogin.tsx:fontSize: 26', 'components/Sidebar.tsx:fontSize: 16', 'app/globals.css:font-size: 14px']);
// Standalone documents (email, downloadable reports) render outside the
// dashboard, where the Text size setting doesn't apply.
const STANDALONE = new Set(['lib/magic-link-email.ts', 'lib/sandbox/report.ts', 'lib/sandbox/practice/report.ts']);
// Any font size that isn't a --fs-* token: fontSize: 12 / '12px' / fontSize={12};
// font-size: 12px / clamp(…) / 2vw (only var(), inherit and the root's % are
// allowed); and the font: shorthand with a size in it.
const FIXED = /fontSize:\s*['"`]?\d[\d.]*|fontSize=\{\s*\d|font-size:(?!\s*(?:var\(|inherit\b|[\d.]+%))\s*[^;}"'\n]+|\bfont:\s*[^;}"'\n]*\d(?:px|rem|em|pt)\b/g;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : files(p);
    return /\.(tsx?|css)$/.test(name) && !/\.test\./.test(name) ? [p] : [];
  });
}

describe('type scale', () => {
  it('uses --fs-* tokens instead of fixed font sizes', () => {
    const bad: string[] = [];
    for (const root of ROOTS) {
      for (const f of files(root)) {
        const rel = relative(root, f);
        if (STANDALONE.has(rel)) continue;
        const src = readFileSync(f, 'utf8');
        const hits = src.match(FIXED) ?? [];
        for (const h of hits) if (!ALLOWED.has(`${rel}:${h}`)) bad.push(`${rel}: ${h}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('keeps the smallest token at 14px or more', () => {
    const css = readFileSync(join(__dirname, '../app/globals.css'), 'utf8');
    const sizes = [...css.matchAll(/--fs-[a-z]+:\s*([\d.]+)rem/g)].map((m) => Number(m[1]) * 16);
    expect(sizes.length).toBeGreaterThanOrEqual(8);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(14);
  });
});
