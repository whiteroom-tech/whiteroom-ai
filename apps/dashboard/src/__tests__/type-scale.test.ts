import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Every font size goes through the rem tokens in globals.css (--fs-*), so the
// Text size setting (Default / Large / Larger) scales all of it and nothing is
// stuck at a fixed, too-small pixel size.
const ROOTS = [join(__dirname, '..'), join(__dirname, '../../../../packages/ui/src')];
// The WhiteRoom wordmark is a brand asset and keeps its fixed size.
const ALLOWED = new Set(['components/citadel/FleetLogin.tsx:fontSize: 26', 'components/Sidebar.tsx:fontSize: 16']);
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

  // The Sandbox's CSS modules included: no stylesheet sets a pixel font size
  // under the floor (the check above already refuses any fixed size).
  it('sets no px font size below 14px in any stylesheet, CSS modules included', () => {
    const MIN_TEXT_PX = 14;
    const sheets = files(ROOTS[0]).filter((f) => f.endsWith('.css'));
    const modules = sheets.filter((f) => f.endsWith('.module.css')).map((f) => relative(ROOTS[0], f));
    expect(modules).toEqual(expect.arrayContaining(['components/sandbox/guided.module.css', 'components/sandbox/sandbox.module.css', 'components/sandbox/practice/practice.module.css']));
    const small = sheets.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/font-size:\s*([\d.]+)px/g)]
      .filter((m) => Number(m[1]) < MIN_TEXT_PX).map((m) => `${relative(ROOTS[0], f)}: ${m[0]}`));
    expect(small).toEqual([]);
  });

  it('keeps every token at 15.5px or more, except the 14px group label', () => {
    const css = readFileSync(join(__dirname, '../app/globals.css'), 'utf8');
    const sizes = [...css.matchAll(/--fs-([a-z]+):\s*([\d.]+)rem/g)].map((m) => [m[1], Number(m[2]) * 16] as const);
    expect(sizes.length).toBeGreaterThanOrEqual(8);
    expect(sizes.filter(([, px]) => px < 15.5).map(([name]) => name)).toEqual(['label']);
    expect(Object.fromEntries(sizes).label).toBe(14);
  });

  // The 14px label is only for the sidebar's uppercase group labels.
  it('uses --fs-label only for the sidebar group labels', () => {
    const css = readFileSync(join(__dirname, '../app/globals.css'), 'utf8');
    const users = css.split('\n').filter((l) => l.includes('var(--fs-label)')).map((l) => l.trim().split(' ')[0]);
    expect(users).toEqual(['.wr-sidebar__eyebrow']);
    for (const root of ROOTS) {
      for (const f of files(root)) if (!f.endsWith('globals.css')) expect(readFileSync(f, 'utf8')).not.toContain('--fs-label');
    }
  });

  // The phone tab bar's labels are the only fixed size: five tabs must fit a
  // 320px phone, so they don't follow Text size. Nothing else may join it.
  it('has one fixed-size token, --fs-tab, at 14px', () => {
    const css = readFileSync(join(__dirname, '../app/globals.css'), 'utf8');
    expect([...css.matchAll(/--fs-[a-z]+:\s*[\d.]+px/g)].map((m) => m[0])).toEqual(['--fs-tab: 14px']);
    expect([...css.matchAll(/var\(--fs-tab\)/g)]).toHaveLength(1);
  });
});
