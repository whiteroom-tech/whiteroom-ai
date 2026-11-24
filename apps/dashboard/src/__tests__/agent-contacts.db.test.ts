import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Against a real Postgres: who may be an agent's contact, and who a notice
// goes to (gap-closing spec A5, contract 0.1 edge cases). Skipped unless
// WR_TEST_DATABASE names a scratch database (its users, user_fleets and
// organization tables are dropped). Needs psql on PATH. For example:
//   createdb -h localhost -p 5433 wr_contacts_test
//   WR_TEST_DATABASE=wr_contacts_test DB_PORT=5433 npx vitest run src/__tests__/agent-contacts.db.test.ts
const DB = process.env.WR_TEST_DATABASE;
const HOST = process.env.DB_HOST || '127.0.0.1';
const PORT = process.env.DB_PORT || '5433';

vi.mock('server-only', () => ({}));
vi.mock('@/auth', () => ({ auth: async () => null }));

const migration = (f: string) => fileURLToPath(new URL(`../../migrations/${f}`, import.meta.url));
const psql = (args: string[]) => execFileSync('psql', ['-h', HOST, '-p', PORT, '-d', DB!, '-v', 'ON_ERROR_STOP=1', '-qAt', ...args], { encoding: 'utf8' });

// The base tables have no DDL in this repo: a stand-in with the columns read here.
const BASE_SCHEMA = `
DROP TABLE IF EXISTS agent_contacts, organization_members, organizations, user_fleets, users CASCADE;
CREATE TABLE users (
  id text PRIMARY KEY, email text, name text, fleet_id text, fleet_token text, fleet_token_enc text,
  fleet_provisioned_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE user_fleets (
  id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, fleet_id text,
  fleet_token text, fleet_token_enc text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE organizations (id text PRIMARY KEY, name text NOT NULL);
CREATE TABLE organization_members (
  org_id text NOT NULL REFERENCES organizations(id), user_id text NOT NULL REFERENCES users(id),
  role text NOT NULL DEFAULT 'member', status text NOT NULL DEFAULT 'active', PRIMARY KEY (org_id, user_id)
);
CREATE UNIQUE INDEX organization_members_one_active_idx ON organization_members (user_id) WHERE status = 'active';`;

const suite = DB ? describe : describe.skip;

suite('agent contacts against Postgres', () => {
  let db: typeof import('@/lib/db').db;
  let contacts: typeof import('@/lib/agent-contacts');
  const q = async (sql: string, params: unknown[] = []) => (await db().query(sql, params)).rows;

  beforeAll(async () => {
    Object.assign(process.env, { DB_HOST: HOST, DB_PORT: PORT, DB_NAME: DB, DB_USER: process.env.DB_USER || process.env.USER });
    psql(['-c', BASE_SCHEMA]);
    psql(['-f', migration('019_agent_contacts.sql')]);
    ({ db } = await import('@/lib/db'));
    contacts = await import('@/lib/agent-contacts');
  });
  afterAll(async () => { await db?.().end(); });
  beforeEach(async () => {
    await q('TRUNCATE agent_contacts, organization_members, organizations, user_fleets, users CASCADE');
    // owner provisioned f1; mate is in owner's org; stranger isn't; rival linked f1 later.
    await q(`INSERT INTO users (id, email, name, fleet_id) VALUES ('owner', 'owner@example.com', 'Owner', 'f1'), ('mate', 'mate@example.com', 'Mate', NULL),
             ('stranger', 'stranger@example.com', NULL, NULL), ('rival', 'rival@example.com', NULL, NULL)`);
    await q(`INSERT INTO user_fleets (id, user_id, fleet_id) VALUES ('uf1', 'rival', 'f1')`);
    await q(`INSERT INTO organizations (id, name) VALUES ('o1', 'Acme')`);
    await q(`INSERT INTO organization_members (org_id, user_id, role) VALUES ('o1', 'owner', 'owner'), ('o1', 'mate', 'member')`);
  });

  it('offers the owner first, then active members of the owner’s organization', async () => {
    expect((await contacts.contactCandidates('owner')).map((c) => c.userId)).toEqual(['owner', 'mate']);
    // An owner with no organization: only themselves.
    expect((await contacts.contactCandidates('stranger')).map((c) => c.userId)).toEqual(['stranger']);
  });

  it('allows only the owner or an active member of their organization', async () => {
    expect(await contacts.isContactAllowed('owner', 'owner')).toBe(true);
    expect(await contacts.isContactAllowed('owner', 'mate')).toBe(true);
    expect(await contacts.isContactAllowed('owner', 'stranger')).toBe(false);
    expect(await contacts.isContactAllowed('owner', 'rival')).toBe(false);
  });

  it('sends a notice to the contact, or the owner when none is set', async () => {
    expect(await contacts.noticeRecipient('f1', 'a1')).toEqual({ userId: 'owner', via: 'owner' });
    await contacts.writeContact('f1', 'a1', 'mate', 'owner');
    expect(await contacts.noticeRecipient('f1', 'a1')).toEqual({ userId: 'mate', via: 'contact' });
  });

  it('clears a contact who left the organization, and tells the owner instead', async () => {
    await contacts.writeContact('f1', 'a1', 'mate', 'owner');
    await q(`UPDATE organization_members SET status = 'removed' WHERE user_id = 'mate'`);
    expect(await contacts.noticeRecipient('f1', 'a1')).toEqual({ userId: 'owner', via: 'owner' });
    expect(await contacts.storedContact('f1', 'a1')).toBeNull();
  });

  it('follows the fleet when its owner unlinks it: a contact from the old owner’s organization is cleared', async () => {
    await contacts.writeContact('f1', 'a1', 'mate', 'owner');
    // The owner unlinks: rival, who linked it later, now owns it.
    await q(`UPDATE users SET fleet_id = NULL WHERE id = 'owner'`);
    expect(await contacts.noticeRecipient('f1', 'a1')).toEqual({ userId: 'rival', via: 'owner' });
    expect(await contacts.storedContact('f1', 'a1')).toBeNull();
  });

  it('clears a stale contact only if it is still the stored one', async () => {
    await contacts.writeContact('f1', 'a1', 'owner', 'owner');
    await contacts.clearStaleContact('f1', 'a1', 'mate');
    expect(await contacts.storedContact('f1', 'a1')).toBe('owner');
    await contacts.clearStaleContact('f1', 'a1', 'owner');
    expect(await contacts.storedContact('f1', 'a1')).toBeNull();
  });

  it('leaves out and refuses a member whose membership isn’t active', async () => {
    await q(`INSERT INTO users (id, email) VALUES ('invitee', 'invitee@example.com')`);
    await q(`INSERT INTO organization_members (org_id, user_id, status) VALUES ('o1', 'invitee', 'invited')`);
    expect((await contacts.contactCandidates('owner')).map((c) => c.userId)).not.toContain('invitee');
    expect(await contacts.isContactAllowed('owner', 'invitee')).toBe(false);
  });

  it('lists the same people it allows, and a user can be active in only one organization', async () => {
    const listed = (await contacts.contactCandidates('owner')).map((c) => c.userId);
    for (const u of ['owner', 'mate', 'stranger', 'rival']) expect(await contacts.isContactAllowed('owner', u)).toBe(listed.includes(u));
    await q(`INSERT INTO organizations (id, name) VALUES ('o2', 'Other')`);
    await expect(q(`INSERT INTO organization_members (org_id, user_id) VALUES ('o2', 'owner')`)).rejects.toThrow();
  });

  it('sends to the owner when the stored contact is the owner', async () => {
    await contacts.writeContact('f1', 'a1', 'owner', 'owner');
    expect(await contacts.noticeRecipient('f1', 'a1')).toEqual({ userId: 'owner', via: 'owner' });
  });

  it('forgets a removed agent’s contact, and only that agent’s', async () => {
    await contacts.writeContact('f1', 'a1', 'mate', 'owner');
    await contacts.writeContact('f1', 'a2', 'mate', 'owner');
    await contacts.forgetAgentContact('f1', 'a1');
    expect(await contacts.storedContact('f1', 'a1')).toBeNull();
    expect(await contacts.storedContact('f1', 'a2')).toBe('mate');
  });

  it('has no recipient for a fleet nobody owns', async () => {
    expect(await contacts.noticeRecipient('nobody', 'a1')).toBeNull();
  });
});
