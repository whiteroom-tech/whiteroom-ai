// The setup lines, shown on Home with no agents and on Fleet key.
// One copy, so the pages can't drift if the proxy URL or header changes.
export const PROXY_ORIGIN = 'https://proxy.whiteroom.tech';

export const SETUP_LINES = {
  anthropic: `export ANTHROPIC_BASE_URL=${PROXY_ORIGIN}`,
  openai: `export OPENAI_BASE_URL=${PROXY_ORIGIN}/v1`,
} as const;

/** The header that names an agent, and the placeholder the recipes use. */
export const AGENT_HEADER = 'x-whiteroom-agent';
export const AGENT_PLACEHOLDER = 'my-agent';

/** The one line that goes with the naming recipes. */
export const AGENT_NAME_WHY = 'Name each agent so WhiteRoom can apply its controls.';

/**
 * Shown wherever someone turns on a control (Enforce, Pause, Stop): with one
 * on, the proxy refuses calls it can't tie to an agent.
 */
export const UNNAMED_CALLS_REFUSED = unnamedCallsRefused('this');

/** The same line, naming the control ("While Enforce is on, …"). */
export function unnamedCallsRefused(control: string): string {
  return `While ${control} is on, calls that don’t name their agent are refused across this fleet.`;
}

/**
 * Naming the agent, per client. The SDKs take it as a default header on the
 * client; Claude Code reads extra headers from ANTHROPIC_CUSTOM_HEADERS.
 */
export const AGENT_NAME_LINES = {
  anthropic: `anthropic.Anthropic(default_headers={"${AGENT_HEADER}": "${AGENT_PLACEHOLDER}"})`,
  openai: `OpenAI(default_headers={"${AGENT_HEADER}": "${AGENT_PLACEHOLDER}"})`,
  claudeCode: `export ANTHROPIC_CUSTOM_HEADERS="${AGENT_HEADER}: ${AGENT_PLACEHOLDER}"  # Claude Code`,
} as const;

/** The naming line for one provider (Azure uses the OpenAI SDK). */
export function agentNameLine(provider: string): string {
  return provider === 'anthropic' ? AGENT_NAME_LINES.anthropic : AGENT_NAME_LINES.openai;
}

export const SETUP_GUIDE_URL = 'https://whiteroom.tech/docs.html';
