import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The engine calls a run a "watch"; users never read that word. Engine
// identifiers keep their names.
const FILES = [
  '../lib/diagnosis/copy.ts',
  '../lib/diagnosis/model.ts',
  '../app/(citadel)/performance/_components/Diagnosis.tsx',
  '../app/(citadel)/performance/page.tsx',
  '../components/agent/AgentDetail.tsx',
  '../lib/home.ts',
  '../components/sandbox/TestRunFlow.tsx',
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

// Customer copy says what WhiteRoom does, never how: runs, progress notes and
// smaller context, not shifts, handovers or compression. Engine identifiers
// keep their names. Rule modes use lib/vocab.ts: Record only and Block, never
// Watch only or Enforce.
const COPY_FILES = [
  ...FILES,
  '../lib/activity.ts',
  '../lib/agent-detail.ts',
  '../lib/runs.ts',
  '../lib/metric-definitions.ts',
  '../lib/handover-quality.ts',
  '../lib/smaller-handovers.ts',
  '../lib/governance.ts',
  '../lib/controls-guard.ts',
  '../components/ActivityFeed.tsx',
  '../components/home/HomeContent.tsx',
  '../components/runs/RunsTable.tsx',
  '../components/runs/RunDetail.tsx',
  '../components/agent/HandoverQualityPanel.tsx',
  '../components/agent/GoalPanel.tsx',
  '../components/settings/DataPrivacySection.tsx',
  '../components/settings/SmallerHandoversSection.tsx',
  '../app/(citadel)/controls/page.tsx',
  '../app/(citadel)/controls/_components/RuleEditor.tsx',
  '../app/(citadel)/controls/_components/AddRuleDialog.tsx',
  '../app/(citadel)/controls/_components/SuggestionDraft.tsx',
  '../app/fleet-key/onboarding.tsx',
  '../app/fleet-key/rotate.tsx',
];

const BANNED = /\bshifts?\b|\bhand(s|ed|ing)? (work )?over\b|\bhandovers?\b|\bcompress(ed|ion)?\b|\bWatch only\b|\bEnforc(e|es|ing)\b|\byour API key\b/i;

function userFacingText(source: string, jsx: boolean): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // Template holes are code (shift.watchNumber), not words.
  const strings = (code.match(/(['`"])(?:(?!\1)[^\n\\]|\\.)*\1/g) ?? []).map((s) => s.replace(/\$\{[^}]*\}/g, ''));
  // JSX text only in .tsx: in plain .ts the pattern would match code between template holes.
  const jsxText = jsx ? code.match(/(?<=[>}])[^<>{}\n]+(?=[<{])/g) ?? [] : [];
  // String literals count only as sentences (a space inside), so identifiers
  // like 'handover_out' pass; JSX text is always visible, even one word.
  return [...strings.filter((s) => /[a-z] [a-z]/i.test(s)), ...jsxText].filter((s) => BANNED.test(s));
}

describe('customer copy', () => {
  it.each(COPY_FILES)('%s keeps internal mechanics and old mode names out', (rel) => {
    const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    expect(userFacingText(src, rel.endsWith('.tsx'))).toEqual([]);
  });
});

describe('shift wording', () => {
  it.each(FILES)('%s never says "watch" for a run', (rel) => {
    const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    expect(userFacingWatch(src)).toEqual([]);
  });
});
