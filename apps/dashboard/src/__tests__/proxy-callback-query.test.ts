// Signed-out visits to a protected page keep the query through sign-in, so a
// link to a rule, a filtered list or an event still opens on it.
import { beforeEach, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { safeCallbackUrl } from '@/lib/callback-url';

const { proxy } = await import('@/proxy');
beforeEach(() => { delete process.env.ADMIN_HOST; delete process.env.CONSOLE_HOST; });

const callbackFor = (path: string) => {
  const res = proxy(new NextRequest(`https://app.whiteroom.tech${path}`));
  return new URL(res.headers.get('location')!).searchParams.get('callbackUrl');
};

it.each(['/controls?rule=gr_audit', '/runs?range=30d&agent=agent-a', '/runs/agent-a~1?event=ev_2', '/runs?agent=a%26b'])('keeps %s whole', (path) => {
  expect(callbackFor(path)).toBe(path);
});

it('a path with no query is unchanged', () => {
  expect(callbackFor('/controls')).toBe('/controls');
});

it('the sign-in page still accepts the kept destination and still refuses off-site ones', () => {
  expect(safeCallbackUrl('/runs?range=30d&agent=agent-a')).toBe('/runs?range=30d&agent=agent-a');
  expect(safeCallbackUrl('//evil.example/runs?x=1')).not.toContain('evil');
  expect(safeCallbackUrl('/\\evil.example')).not.toContain('evil');
});
