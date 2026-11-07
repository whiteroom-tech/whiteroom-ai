import 'server-only';
import { fail, json, postEngine, sandboxPin, type SandboxFleetOwner } from './fleet-server';
import { helperCodeOf, helperStatusOf, runAnswerOf, runCheck, SANDBOX_HELPER_ENGINE_ACTION, type SandboxHelperAction } from './helper';

// The BFF side of the Sandbox helper (spec sandbox-v2 §6, §7 S4). Same owner
// check as the rest of Sandbox v2 (sandboxFleetOwner). Every engine call names
// a sandbox_helper_* action from a fixed map, and Run sends a prompt only —
// never a command. The page's `sandboxFleetId` pins the Sandbox (409 when it
// changed under the page).

/** The engine body for `action`, from known fields only, or the refusal. */
export function helperEngineBody(action: SandboxHelperAction, fleet: string, body: Record<string, unknown>): Record<string, unknown> | { error: Response } {
  const pin = sandboxPin(body.sandboxFleetId);
  if ('error' in pin) return pin;
  const base = { action: SANDBOX_HELPER_ENGINE_ACTION[action], fleet_id: fleet, ...pin };
  if (action !== 'run') return base;
  const check = runCheck(body);
  return check.ok ? { ...base, ...check.request } : { error: fail(400, check.error) };
}

/** One Sandbox helper call, its answer cut down to what the page may see. */
export async function sandboxHelperEngine(action: SandboxHelperAction, owner: SandboxFleetOwner, body: Record<string, unknown>): Promise<Response> {
  const answer = await postEngine(owner, body);
  if ('error' in answer) return answer.error;
  const read = action === 'code' ? helperCodeOf(answer.data) : action === 'run' ? runAnswerOf(answer.data) : helperStatusOf(answer.data);
  return read ? json(200, { success: true, ...read }) : fail(502, 'WhiteRoom sent an answer the dashboard couldn’t read. Try again.');
}
