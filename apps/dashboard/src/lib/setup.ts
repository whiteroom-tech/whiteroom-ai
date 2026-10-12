// The setup lines, shown on Home with no agents and on Fleet key.
// One copy, so the pages can't drift if the proxy URL or header changes.
export const PROXY_ORIGIN = 'https://proxy.whiteroom.tech';

export const SETUP_LINES = {
  anthropic: `export ANTHROPIC_BASE_URL=${PROXY_ORIGIN}`,
  openai: `export OPENAI_BASE_URL=${PROXY_ORIGIN}/v1`,
} as const;

/** The header that names an agent, and the placeholder the recipes use. */
export const AGENT_HEADER = 'x-whiteroom-agent';
export const AGENT_PLACEHOLDER = '<agent-name>';

/** Title of the collapsed naming recipes: most agents need none of it. */
export const AGENT_NAME_TITLE = 'Agents without a system prompt';
export const AGENT_NAME_WHY = 'Agents with a system prompt are named automatically. For one without, send its name in a header:';

/** The header itself, language-neutral, shown before the client examples. */
export const AGENT_HEADER_LINE = `${AGENT_HEADER}: ${AGENT_PLACEHOLDER}`;

const PY_HEADERS = `default_headers={"${AGENT_HEADER}": "${AGENT_PLACEHOLDER}"}`;
const TS_HEADERS = `defaultHeaders: { "${AGENT_HEADER}": "${AGENT_PLACEHOLDER}" }`;

/** Naming the agent per client: SDKs take a default header on the client. */
export const AGENT_NAME_LINES = {
  python: {
    anthropic: `client = anthropic.Anthropic(${PY_HEADERS})`,
    openai: `client = openai.OpenAI(${PY_HEADERS})`,
  },
  typescript: {
    anthropic: `const client = new Anthropic({ ${TS_HEADERS} });`,
    openai: `const client = new OpenAI({ ${TS_HEADERS} });`,
  },
  /** Claude Code reads extra headers from ANTHROPIC_CUSTOM_HEADERS. */
  claudeCode: `export ANTHROPIC_CUSTOM_HEADERS="${AGENT_HEADER_LINE}"`,
} as const;

/** The Python header argument, for snippets that build their own client (Azure). */
export const AGENT_PY_HEADERS = PY_HEADERS;

/** Shown when someone turns on Pause, Stop or a Stop rule in Enforce. */
export const UNNAMED_CALLS_REFUSED = 'Calls WhiteRoom can’t tie to an agent are refused across this fleet while this is on.';

/** The ⓘ beside a rule in Enforce. */
export const UNNAMED_CALLS_ENFORCE = 'Calls from agents WhiteRoom can’t identify are refused fleet-wide while a rule is in Enforce.';

export const SETUP_GUIDE_URL = 'https://whiteroom.tech/docs.html';
