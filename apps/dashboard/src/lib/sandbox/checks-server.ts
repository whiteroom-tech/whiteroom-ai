import 'server-only';
import { fail, json, postEngine, sandboxPin, type SandboxFleetOwner } from './fleet-server';
import { checkStateOf, SANDBOX_CHECKS_ENGINE_ACTION, startCheck, type SandboxChecksAction } from './checks';

// The BFF side of Sandbox checks (spec sandbox-v2 §5). Same owner check as the
// rest of Sandbox v2 (sandboxFleetOwner). Every engine call names a
// sandbox_check_* action from a fixed map; the engine finds the Sandbox from
// the production fleet, and the page's `sandboxFleetId` pins it (409 when the
// Sandbox changed under the page).

/** The engine body for `action`, from known fields only, or the refusal. */
export function checksEngineBody(action: SandboxChecksAction, fleet: string, body: Record<string, unknown>): Record<string, unknown> | { error: Response } {
  const pin = sandboxPin(body.sandboxFleetId);
  if ('error' in pin) return pin;
  const base = { action: SANDBOX_CHECKS_ENGINE_ACTION[action], fleet_id: fleet, ...pin };
  if (action !== 'start') return base;
  const check = startCheck(body);
  return check.ok ? { ...base, ...check.request } : { error: fail(400, check.error) };
}

/** One Sandbox checks call, its answer cut down to what the page may see. */
export async function sandboxChecksEngine(action: SandboxChecksAction, owner: SandboxFleetOwner, body: Record<string, unknown>): Promise<Response> {
  const answer = await postEngine(owner, body);
  if ('error' in answer) return answer.error;
  const state = checkStateOf(answer.data);
  if (state) return json(200, { success: true, ...state });
  // Start and Stop may answer without the state: the page reads it next.
  return action === 'status' ? fail(502, 'WhiteRoom sent an answer the dashboard couldn’t read. Try again.') : json(200, { success: true });
}
