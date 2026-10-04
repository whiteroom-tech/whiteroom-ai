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

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canUpdate, compare, findColors } from './color-check-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '..');
const repo = join(app, '..', '..');
const ROOTS = [join(app, 'src'), join(repo, 'packages', 'ui', 'src')];
const EXTENSIONS = /\.(ts|tsx|css|mjs|js)$/;
const BASELINE = join(here, 'color-baseline.json');

// Never checked: the token file itself, and places where a CSS variable can't
// work. Email HTML is rendered by mail clients, the Sandbox report is a
// standalone downloaded page with no access to the app's tokens, and the logo
// is a fixed brand mark that looks the same in both themes.
const EXEMPT = new Set([
  'apps/dashboard/src/app/globals.css',
  'apps/dashboard/src/lib/magic-link-email.ts',
  'apps/dashboard/src/lib/sandbox/report.ts',
  'packages/ui/src/Logo.tsx',
]);

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
      const css = file.endsWith('.css');
      const hits = [];
      lines.forEach((line, i) => {
        for (const c of findColors(line, { css })) hits.push(`${i + 1}: ${c}`);
      });
      if (hits.length) found[rel] = hits;
    }
  }
  return found;
}

/** The saved baseline, or null when there isn't one yet. Read once, no exists-check race. */
function readBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

const found = scan();
const counts = Object.fromEntries(Object.entries(found).map(([f, h]) => [f, h.length]).sort());

if (process.argv.includes('--update')) {
  const { ok, grew } = canUpdate(readBaseline(), counts);
  if (!ok) {
    console.error('Refusing to raise the baseline. These files gained raw colors:');
    for (const [f, n] of grew) console.error(`  ${f}: now ${n}`);
    process.exit(1);
  }
  writeFileSync(BASELINE, JSON.stringify(counts, null, 2) + '\n');
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`Baseline written: ${total} literals in ${Object.keys(counts).length} files.`);
  process.exit(0);
}

const baseline = readBaseline() ?? {};
const { over, lowered } = compare(baseline, counts);
for (const file of over) {
  console.error(`${file}: ${counts[file]} raw colors (baseline ${baseline[file] ?? 0}). Use a token from app/globals.css instead.`);
  for (const h of found[file]) console.error(`  ${h}`);
}
if (lowered.length) {
  console.log(`Fewer raw colors than the baseline in ${lowered.length} file(s). Run \`npm run lint:colors:update\` to lock that in.`);
}
if (over.length) process.exit(1);
const total = Object.values(counts).reduce((a, b) => a + b, 0);
console.log(`check-colors: ok (${total} baselined literals left to retokenize).`);
