-- Enterprise organizations.
--
-- Until now every account stood alone: one person, their fleets, their
-- subscription. An enterprise customer is many people whose fleets somebody on
-- their side needs to see in one place. This adds the grouping, and nothing
-- else — billing, entitlements and fleet ownership all stay per user. A fleet
-- still belongs to the person who linked it; an organization only decides who
-- else may look at it.
--
-- Idempotent: safe to re-run, same as 001-005.

-- 1. The organization itself.
--
--    Created by a WhiteRoom admin, never self-serve — see the note at the
--    bottom. created_by is not a foreign key for the same reason
--    admin_audit_log.actor_user_id isn't: deleting that admin must not take the
--    organization with them.
CREATE TABLE IF NOT EXISTS organizations (
  id         text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name       text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2. Membership.
--
--    Three roles, and what each one sees is decided in lib/organizations.ts:
--
--      owner  — everything an admin can do, plus granting and revoking owner.
--      admin  — sees every member's fleets and usage, adds and removes members.
--      member — sees who else is in the organization, and nothing of theirs.
--
--    status is what makes adding someone safe. Joining an organization hands
--    its owners and admins a view of your fleets, so it cannot be something
--    done TO an account: an organization admin who could add any address and
--    have it take effect could read a stranger's fleets by typing their email.
--    A row added from the customer dashboard therefore starts as 'invited',
--    exposes nothing, and becomes 'active' only when that person accepts while
--    signed in. A WhiteRoom admin adding someone from the admin panel creates
--    the row as 'active' directly — that is how an organization gets its first
--    owner, and those admins can already see every fleet.
--
--    One ACTIVE organization per account, enforced by the partial unique index
--    below. The customer dashboard has a single "your organization" page, and
--    allowing several would mean a switcher and a notion of "current
--    organization" that nothing needs yet. Pending invitations are not
--    limited: being invited somewhere must not depend on whether you have
--    already been invited somewhere else.
CREATE TABLE IF NOT EXISTS organization_members (
  org_id      text NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id     text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  status      text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active')),
  added_by    text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  PRIMARY KEY (org_id, user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS organization_members_one_active_idx
  ON organization_members (user_id) WHERE status = 'active';

-- Looking up "what am I a member of / invited to" is by user, and the primary
-- key leads with org_id.
CREATE INDEX IF NOT EXISTS organization_members_user_idx
  ON organization_members (user_id);

-- 3. Audit log for membership changes.
--
--    Separate from admin_audit_log because the audience is different: this one
--    is shown to the organization's own owners and admins, and admin_audit_log
--    must never be. A WhiteRoom admin's change to an organization is written
--    to both. Denormalised emails and no foreign keys on the user columns, for
--    the reasons given in 004_admin.sql.
CREATE TABLE IF NOT EXISTS organization_audit_log (
  id             bigserial PRIMARY KEY,
  org_id         text NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  actor_user_id  text NOT NULL,
  actor_email    text,
  action         text NOT NULL,
  target_user_id text,
  target_email   text,
  details        jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS organization_audit_log_org_idx
  ON organization_audit_log (org_id, created_at DESC);

-- 4. Organizations are created from the admin panel (/admin/organizations),
--    which also names the first owner. There is no self-serve "create an
--    organization" in the customer dashboard: an organization is a contract
--    with a customer, not something any account should be able to start.
--
--    Invitations name an existing account rather than an email address, so
--    the person has to have signed in once before they can be invited. That
--    keeps acceptance tied to a session the invitee already proved, instead of
--    to whoever next signs in claiming the address.
