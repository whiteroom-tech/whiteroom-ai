import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Every "point your agent here" line uses the proxy-key form the Fleet key
// page issues (<origin>/<proxy key>, OpenAI …/v1). A bare base URL would send
// the agent's calls somewhere other than the account's own fleet.
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function files(dir: string, exts: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === '.next' || name === '__tests__') return [];
    return statSync(path).isDirectory() ? files(path, exts) : exts.test(name) ? [path] : [];
  });
}

// A base-URL setting whose value is an origin (literal or the build's) with
// nothing after it but an optional /v1.
const BARE = /(?:ANTHROPIC|OPENAI)_BASE_URL"?\s*=\s*["']?(?:https:\/\/(?:eu\.)?proxy\.whiteroom\.tech|\$\{(?:PROXY_ORIGIN|PROXY_URL)\})(?:\/v1)?(?:["'`\s<]|$)/m;

describe('connect lines', () => {
  const sources = [
    ...files(join(ROOT, 'apps/dashboard/src'), /\.tsx?$/),
    join(ROOT, 'README.md'),
    join(ROOT, 'SKILL.md'),
    join(ROOT, 'packages/cli/README.md'),
    join(ROOT, 'docs/docs.html'),
  ];

  // docs.html wraps the variable in markup: drop the tags first.
  const text = (path: string) => readFileSync(path, 'utf8').replace(/<\/?span[^>]*>/g, '');

  it('the check sees a bare line, and passes the proxy-key form', () => {
    expect(BARE.test('export ANTHROPIC_BASE_URL=https://proxy.whiteroom.tech\n')).toBe(true);
    expect(BARE.test('export OPENAI_BASE_URL=${PROXY_ORIGIN}/v1`')).toBe(true);
    expect(BARE.test('export ANTHROPIC_BASE_URL=https://proxy.whiteroom.tech/<your-proxy-key>')).toBe(false);
    expect(BARE.test('export OPENAI_BASE_URL=${PROXY_KEY_URL}/v1`')).toBe(false);
  });

  it('none is left in the dashboard, the READMEs or the docs', () => {
    expect(sources.length).toBeGreaterThan(100);
    expect(sources.filter((f) => BARE.test(text(f))).map((f) => f.slice(ROOT.length))).toEqual([]);
  });
});
