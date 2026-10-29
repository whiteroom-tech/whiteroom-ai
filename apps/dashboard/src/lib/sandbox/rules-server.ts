import 'server-only';
import { fail, json, postEngine, sandboxPin, type SandboxFleetOwner } from './fleet-server';
import { ruleCreateCheck, ruleDeleteCheck, ruleOf, rulesStateOf, ruleUpdateCheck, SANDBOX_RULES_ENGINE_ACTION, type SandboxRulesAction } from './rules';

// The BFF side of Sandbox rules (spec sandbox-v2 §1 decision 3, §8.2). Same
// owner check as the rest of Sandbox v2 (sandboxFleetOwner). Every engine call
// here names a sandbox_rules_* / sandbox_rule_* action from a fixed map, so
// this route can never write a production rule. The engine finds the Sandbox
// from the production fleet; the page's `sandboxFleetId` pins it (409 when the
// Sandbox changed under the page).

/** The engine body for `action`, from known fields only, or the refusal. */
export function rulesEngineBody(action: SandboxRulesAction, fleet: string, body: Record<string, unknown>): Record<string, unknown> | { error: Response } {
  const pin = sandboxPin(body.sandboxFleetId);
  if ('error' in pin) return pin;
  const base = { action: SANDBOX_RULES_ENGINE_ACTION[action], fleet_id: fleet, ...pin };
  if (action === 'list' || action === 'ready-made' || action === 'copy-production') return base;
  const check = action === 'create' ? ruleCreateCheck(body) : action === 'update' ? ruleUpdateCheck(body) : ruleDeleteCheck(body);
  if (!check.ok) return { error: fail(400, check.error) };
  return { ...base, ...check.request };
}

/** One Sandbox rules call, its answer cut down to what the page may see. */
export async function sandboxRulesEngine(action: SandboxRulesAction, owner: SandboxFleetOwner, body: Record<string, unknown>): Promise<Response> {
  const answer = await postEngine(owner, body);
  if ('error' in answer) return answer.error;
  const unreadable = () => fail(502, 'WhiteRoom sent an answer the dashboard couldn’t read. Try again.');
  if (action === 'delete') return json(200, { success: true });
  if (action === 'create' || action === 'update') {
    const rule = ruleOf((answer.data as { rule?: unknown } | null)?.rule);
    return rule ? json(200, { success: true, rule }) : unreadable();
  }
  const state = rulesStateOf(answer.data);
  return state ? json(200, { success: true, ...state }) : unreadable();
}
