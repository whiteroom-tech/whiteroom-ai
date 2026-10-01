import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// README › Labels: users read "shift", never "watch". Engine identifiers keep
// their names.
const FILES = [
  '../lib/diagnosis/copy.ts',
  '../lib/diagnosis/model.ts',
  '../app/(citadel)/performance/_components/Diagnosis.tsx',
  '../app/(citadel)/performance/page.tsx',
  '../components/agent/AgentDetail.tsx',
  '../lib/home.ts',
];

function userFacingWatch(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const strings = code.match(/(['`"])(?:(?!\1)[^\n\\]|\\.)*\1/g) ?? [];
  // JSX text runs between a tag or expression and the next one: >text<, >text{, }text<.
  const jsxText = code.match(/(?<=[>}])[^<>{}\n]+(?=[<{])/g) ?? [];
  // Lower-case "watch" or "Watch #3" meant a shift; capitalised "Watch" alone
  // is the Controls mode (Off / Watch / Enforce).
  return [...strings, ...jsxText].filter((s) =>
    (/\bwatch(es)?\b/.test(s) || /\bWatch\s*#?\d/.test(s)) && !/^['"`](watches|watch)['"`]$|check_watch/.test(s));
}

describe('shift wording', () => {
  it.each(FILES)('%s shows "shift", not "watch"', (rel) => {
    const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    expect(userFacingWatch(src)).toEqual([]);
  });
});
