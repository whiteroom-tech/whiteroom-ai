#!/usr/bin/env node
// Fails on raw color literals (hex, rgb(), rgba(), hsl(), hsla()) in the
// dashboard's src and in @whiteroom/ui. Colors belong in app/globals.css as
// theme tokens; code uses var(--token) or `color` from @whiteroom/ui.
//
// Existing literals are frozen in color-baseline.json, per file. A file may go
// down but never up, and a file not in the baseline may have none. After
// removing literals, run `npm run lint:colors:update` to lower the baseline.
//
// Usage: node scripts/check-colors.mjs [--update]

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '..');
const repo = join(app, '..', '..');
const ROOTS = [join(app, 'src'), join(repo, 'packages', 'ui', 'src')];
const EXTENSIONS = /\.(ts|tsx|css|mjs|js)$/;
const BASELINE = join(here, 'color-baseline.json');

// Never checked: the token file itself, and places where a CSS variable can't
// work. Email HTML is rendered by mail clients, and the logo is a fixed brand
// mark that looks the same in both themes.
const EXEMPT = new Set([
  'apps/dashboard/src/app/globals.css',
  'apps/dashboard/src/lib/magic-link-email.ts',
  'packages/ui/src/Logo.tsx',
]);

// `&#8594;`-style HTML entities aren't colors, hence the lookbehind.
const COLOR = /(?<![\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b|\b(?:rgba?|hsla?)\(/g;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (EXTENSIONS.test(name) && !/\.test\.ts$/.test(name)) out.push(path);
  }
  return out;
}

function scan() {
  const found = {};
  for (const root of ROOTS) {
    for (const file of walk(root)) {
      const rel = relative(repo, file);
      if (EXEMPT.has(rel)) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      const hits = [];
      lines.forEach((line, i) => {
        for (const m of line.matchAll(COLOR)) hits.push(`${i + 1}: ${m[0]}`);
      });
      if (hits.length) found[rel] = hits;
    }
  }
  return found;
}

const found = scan();
const counts = Object.fromEntries(Object.entries(found).map(([f, h]) => [f, h.length]).sort());

if (process.argv.includes('--update')) {
  const old = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {};
  const grew = Object.entries(counts).filter(([f, n]) => n > (old[f] ?? 0));
  if (grew.length && Object.keys(old).length) {
    console.error('Refusing to raise the baseline. These files gained raw colors:');
    for (const [f, n] of grew) console.error(`  ${f}: ${old[f] ?? 0} -> ${n}`);
    process.exit(1);
  }
  writeFileSync(BASELINE, JSON.stringify(counts, null, 2) + '\n');
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`Baseline written: ${total} literals in ${Object.keys(counts).length} files.`);
  process.exit(0);
}

const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {};
let failed = false;
for (const [file, hits] of Object.entries(found)) {
  const allowed = baseline[file] ?? 0;
  if (hits.length > allowed) {
    failed = true;
    console.error(`${file}: ${hits.length} raw colors (baseline ${allowed}). Use a token from app/globals.css instead.`);
    for (const h of hits) console.error(`  ${h}`);
  }
}
const lowered = Object.entries(baseline).filter(([f, n]) => (counts[f] ?? 0) < n);
if (lowered.length) {
  console.log(`Fewer raw colors than the baseline in ${lowered.length} file(s). Run \`npm run lint:colors:update\` to lock that in.`);
}
if (failed) process.exit(1);
const total = Object.values(counts).reduce((a, b) => a + b, 0);
console.log(`check-colors: ok (${total} baselined literals left to retokenize).`);
