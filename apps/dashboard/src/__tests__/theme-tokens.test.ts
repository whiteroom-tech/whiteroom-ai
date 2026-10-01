import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COLOR_TOKENS } from '@whiteroom/ui';

// Reads the theme blocks straight from globals.css, so the test checks the
// values the browser actually gets.
const css = readFileSync(fileURLToPath(new URL('../app/globals.css', import.meta.url)), 'utf8');

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`missing block: ${selector}`);
  const body = css.slice(start + selector.length + 2, css.indexOf('}', start));
  const vars: Record<string, string> = {};
  for (const m of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
  return vars;
}

const dark = block('.wr-shell');
const lightSystem = block(':root:not([data-wr-theme="dark"]) .wr-shell:not([data-theme="dark"])');
const light = block('.wr-shell[data-theme="light"],\n:root[data-wr-theme="light"] .wr-shell:not([data-theme="dark"])');

type RGBA = [number, number, number, number];

function parse(value: string): RGBA {
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgba = value.match(/^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/);
  if (rgba) return [+rgba[1], +rgba[2], +rgba[3], +rgba[4]];
  throw new Error(`can't parse color: ${value}`);
}

// A translucent token (brand-dim) sits on an opaque surface.
function over([r, g, b, a]: RGBA, [br, bg, bb]: RGBA): RGBA {
  return [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a), 1];
}

function luminance([r, g, b]: RGBA): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(fg: RGBA, bg: RGBA): number {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

// Every token people read text in, including the legacy ones still in use.
const TEXT = ['tx', 'tx2', 'tx3', 'brand', 'ok', 'warn', 'warn-tx', 'bad', 'ho', 'info'];
const SURFACES = ['card', 'bg', 'sunk', 'raised'];
// Text on its own tinted fill: pills, banners, filled buttons.
const PAIRS: [string, string][] = [
  ['on-brand', 'brand'],
  ['on-brand', 'bad'],
  ['warn', 'warn-bg'],
  ['ok', 'ok-bg'],
  ['bad', 'bad-bg'],
  ['ho', 'ho-bg'],
  ['info', 'info-bg'],
];

describe.each([
  ['dark', dark],
  ['light', light],
])('%s theme', (_name, theme) => {
  it('defines every spec token', () => {
    for (const t of COLOR_TOKENS) expect(theme[t], `--${t}`).toBeDefined();
  });

  it.each(TEXT.flatMap((t) => SURFACES.map((s) => [t, s])))('--%s on --%s passes AA', (text, surface) => {
    expect(contrast(parse(theme[text]), parse(theme[surface]))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(PAIRS)('--%s on --%s passes AA', (text, fill) => {
    const base = parse(theme.card);
    expect(contrast(parse(theme[text]), over(parse(theme[fill]), base))).toBeGreaterThanOrEqual(4.5);
  });

  // brand-dim marks the active nav item, a selected row or segment, and a
  // toggled-on button, so it can sit on any surface.
  it.each(SURFACES)('--brand on --brand-dim over --%s passes AA', (surface) => {
    const selected = over(parse(theme['brand-dim']), parse(theme[surface]));
    expect(contrast(parse(theme.brand), selected)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('light theme blocks', () => {
  it('the system-preference block matches the explicit toggle block', () => {
    expect(lightSystem).toEqual(light);
  });

  it('dark and light define the same tokens', () => {
    expect(Object.keys(light).sort()).toEqual(Object.keys(dark).sort());
  });
});
