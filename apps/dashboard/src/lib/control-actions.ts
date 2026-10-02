import 'server-only';

import { db } from '@/lib/db';
import type { ControlActor } from '@/lib/control-actors';

/** The control actions a page names a person for: holds and rule changes. */
const RECORDED = new Set([
  'pause_agent', 'stop_agent',
  'governance_create_rule', 'governance_update_rule', 'governance_delete_rule',
]);

/** Pages read 30 days back; keep a little longer, then prune. */
const KEEP_DAYS = 45;

/**
 * The agent and rule a control body names. A new rule's id comes from the
 * engine's reply, since the request can't know it.
 */
export function controlTarget(body: string, reply: string): { agentId: string | null; ruleId: string | null } {
  const read = (s: string): Record<string, unknown> => {
    try {
      const v: unknown = JSON.parse(s);
      return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  const req = read(body);
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const rule = read(reply).rule;
  const replyRuleId = rule && typeof rule === 'object' ? str((rule as Record<string, unknown>).id) : null;
  return { agentId: str(req.agent_id), ruleId: str(req.rule_id) ?? replyRuleId };
}

/** Records who made an accepted control change. Best effort: the change already happened. */
export async function recordControlAction(userId: string, fleetId: string, action: string, body: string, reply: string): Promise<void> {
  if (!RECORDED.has(action)) return;
  const { agentId, ruleId } = controlTarget(body, reply);
  try {
    await db().query(
      'INSERT INTO control_actions (fleet_id, action, agent_id, rule_id, user_id) VALUES ($1, $2, $3, $4, $5)',
      [fleetId, action, agentId, ruleId, userId],
    );
    // Prune this fleet's old rows as it writes; one indexed delete per change.
    await db().query(`DELETE FROM control_actions WHERE fleet_id = $1 AND created_at < now() - make_interval(days => $2)`, [fleetId, KEEP_DAYS]);
  } catch (e) {
    console.warn('[control-actions] not recorded:', e instanceof Error ? e.message : e);
  }
}

/** Whether the account holds this fleet (its own, or linked). Viewers may read who acted; only owners act. */
export async function holdsFleet(userId: string, fleetId: string): Promise<boolean> {
  const { rows } = await db().query(
    `SELECT 1 FROM users WHERE id = $1 AND fleet_id = $2
     UNION ALL SELECT 1 FROM user_fleets WHERE user_id = $1 AND fleet_id = $2 LIMIT 1`,
    [userId, fleetId],
  );
  return rows.length > 0;
}

/**
 * The fleet's control actions since `since` (newest first, at most 500),
 * with each person's display name. Never an email address: any account
 * holding the fleet may read this, so unnamed people show as "a teammate".
 */
export async function recentControlActions(fleetId: string, since: Date): Promise<ControlActor[]> {
  const { rows } = await db().query(
    `SELECT c.action, c.agent_id AS "agentId", c.rule_id AS "ruleId", c.created_at AS at,
            COALESCE(NULLIF(u.name, ''), 'a teammate') AS by
       FROM control_actions c JOIN users u ON u.id = c.user_id
      WHERE c.fleet_id = $1 AND c.created_at >= $2 ORDER BY c.created_at DESC LIMIT 500`,
    [fleetId, since],
  );
  return rows.map((r: ControlActor & { at: Date | string }) => ({ ...r, at: new Date(r.at).toISOString() }));
}
