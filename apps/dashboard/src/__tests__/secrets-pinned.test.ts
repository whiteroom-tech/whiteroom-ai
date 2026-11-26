// Every secret the dashboard deploys with is pinned to a version (SOC 2 register
// KEY-01), so a new version reaches it only through a reviewed change. US prod's
// Promote changes the image only; its secret references live on the service.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const files = ['.github/workflows/deploy-staging.yml', 'cloudbuild-dashboard-eu.yaml'];
const SECRET_REF = /=([a-z0-9-]+):([A-Za-z0-9]+)/g;

describe('deploy secrets', () => {
  for (const file of files) {
    it(`are pinned to a version number in ${file}`, () => {
      const text = readFileSync(join(root, file), 'utf8');
      const line = text.split('\n').find((l) => l.includes('--set-secrets') && !l.trim().startsWith('#'));
      expect(line, 'a --set-secrets line').toBeTruthy();
      const refs = [...line!.matchAll(SECRET_REF)].map((m) => ({ name: m[1], version: m[2] }));
      expect(refs.length).toBeGreaterThan(5);
      for (const r of refs) expect(r.version, `${r.name} in ${file}`).toMatch(/^[1-9][0-9]*$/);
    });
  }
});
