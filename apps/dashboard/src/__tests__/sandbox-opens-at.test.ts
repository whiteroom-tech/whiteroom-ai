import { beforeEach, expect, it, vi } from 'vitest';

// When a Free account made over the day's sign-up cap gets its Sandbox: only a
// readable time still ahead holds it back.
const m = vi.hoisted(() => ({ value: null as unknown, sql: '' }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ db: () => ({ query: async (sql: string) => { m.sql = sql; return { rows: [{ sandbox_opens_at: m.value }] }; } }) }));
const { sandboxOpensAt } = await import('@/lib/sandbox-opens-at');

const NOW = new Date('2026-11-08T20:00:00Z');
beforeEach(() => { m.value = null; });

it('reads the account’s own row', async () => {
  await sandboxOpensAt('u1', NOW);
  expect(m.sql).toBe('SELECT sandbox_opens_at FROM users WHERE id = $1');
});

it.each([
  ['null', null, null],
  ['a past time', new Date('2026-11-08T00:00:00Z'), null],
  ['exactly now', NOW, null],
  ['an unreadable value', 'not a time', null],
  ['a future Date', new Date('2026-11-09T00:00:00Z'), '2026-11-09T00:00:00.000Z'],
  ['a future string', '2026-11-09T00:00:00Z', '2026-11-09T00:00:00.000Z'],
])('%s', async (_name, value, expected) => {
  m.value = value;
  expect((await sandboxOpensAt('u1', NOW))?.toISOString() ?? null).toBe(expected);
});
