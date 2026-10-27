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

/**
 * Claude on AWS Bedrock with a Bedrock API key. The Anthropic SDK talks to the
 * proxy URL exactly as it would to Anthropic (it adds /v1/messages and sends
 * the key as x-api-key); WhiteRoom forwards to Bedrock's Messages endpoint in
 * the region the key was connected with. Mantle model ids are anthropic. plus
 * the model name, with no region prefix or version suffix.
 */
const BEDROCK_PROXY = `${PROXY_ORIGIN}/<your-proxy-key>`;
/** AWS's standard variable for a Bedrock API key; Sandbox's Bedrock recipe reads the same one. */
export const BEDROCK_KEY_ENV = 'AWS_BEARER_TOKEN_BEDROCK';
const BEDROCK_MODEL = 'anthropic.claude-haiku-4-5';

/** The notes under the Bedrock recipe: where the key comes from, region, model ids. */
export const BEDROCK_NOTES = {
  key: 'Bedrock console → API keys. Long-term keys start ABSK. Short-term keys (bedrock-api-key-…) expire within 12 hours, so your agent must send a fresh one.',
  region: 'Use a region where Claude is available on Bedrock.',
  custody: 'Your agent sends its own key on each call; WhiteRoom only keeps a fingerprint of it.',
  model: `Use Mantle model ids: anthropic. plus the model name, with no region prefix or version suffix (e.g. ${BEDROCK_MODEL}).`,
} as const;

export const BEDROCK_LINES = {
  baseUrl: `export ANTHROPIC_BASE_URL=${BEDROCK_PROXY}`,
  apiKey: `export ANTHROPIC_API_KEY="$${BEDROCK_KEY_ENV}"`,
  python: `import os
import anthropic

client = anthropic.Anthropic(
    base_url="${BEDROCK_PROXY}",
    api_key=os.environ["${BEDROCK_KEY_ENV}"],
    ${PY_HEADERS},  # optional if your agent has a system prompt
)
client.messages.create(
    model="${BEDROCK_MODEL}",  # Mantle model id
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello"}],
)`,
  typescript: `import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: "${BEDROCK_PROXY}",
  apiKey: process.env.${BEDROCK_KEY_ENV},
  ${TS_HEADERS}, // optional if your agent has a system prompt
});
await client.messages.create({
  model: "${BEDROCK_MODEL}", // Mantle model id
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello" }],
});`,
} as const;

/**
 * Native Bedrock Runtime adapter: no API key at all. The customer's agent
 * keeps its own AWS credentials and signs calls as itself; WhiteRoom proves
 * who's calling via a signed sts:GetCallerIdentity replay (not a bearer
 * token), then re-signs onto its own assumed-role credentials for the real
 * Bedrock call. Any model, not just Claude — see sdks/bedrock-python.
 *
 * BEDROCK_ROLE_PRINCIPAL_ARN is the IAM user the production engine
 * authenticates as to call sts:AssumeRole (see bedrock/credentials.ts's
 * assumeRole()) — the identity every customer's trust policy names. Not a
 * secret: an ARN is a public identifier, meant to be pasted into customer
 * IAM policies, same as a username. The access key behind it is the secret,
 * held only in the engine's own deployment config.
 */
export const BEDROCK_ROLE_SERVER_ID = new URL(PROXY_ORIGIN).hostname;
export const BEDROCK_ROLE_PRINCIPAL_ARN = 'arn:aws:iam::867709894307:user/whiteroom-engine-prod';

/** The IAM trust policy the customer attaches to the role they create, naming WhiteRoom's principal and their chosen external ID. */
export function bedrockRoleTrustPolicy(externalId: string): string {
  return JSON.stringify(
    {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { AWS: BEDROCK_ROLE_PRINCIPAL_ARN },
          Action: 'sts:AssumeRole',
          Condition: { StringEquals: { 'sts:ExternalId': externalId } },
        },
      ],
    },
    null,
    2,
  );
}

export const BEDROCK_ROLE_LINES = {
  pythonInstall: 'pip install whiteroom-bedrock',
  python: (region: string) => `import boto3
import whiteroom_bedrock

client = boto3.client(
    "bedrock-runtime",
    region_name="${region}",
    endpoint_url="${PROXY_ORIGIN}",
)
whiteroom_bedrock.install(
    client,
    proxy_base_url="${PROXY_ORIGIN}",
    server_id="${BEDROCK_ROLE_SERVER_ID}",
    region="${region}",
)

# From here down it's a normal bedrock-runtime client: converse,
# converse_stream, invoke_model and invoke_model_with_response_stream
# all go through WhiteRoom. The system prompt names the agent.
response = client.converse(
    modelId="us.anthropic.claude-haiku-4-5-20251001-v1:0",
    system=[{"text": "Your role: research agent."}],
    messages=[{"role": "user", "content": [{"text": "hi"}]}],
)`,
} as const;

/** What the Cross-account role route supports, under its recipe. */
export const BEDROCK_ROLE_SUPPORT = [
  'Converse and ConverseStream: every Bedrock model.',
  'InvokeModel and InvokeModelWithResponseStream: Claude, Amazon Nova, Meta Llama and Mistral.',
] as const;

/** Shown when someone turns on Pause, Stop or a Stop rule in Enforce. */
export const UNNAMED_CALLS_REFUSED = 'Calls WhiteRoom can’t tie to an agent are refused across this fleet while this is on.';

/** The ⓘ beside a rule in Enforce. */
export const UNNAMED_CALLS_ENFORCE = 'Calls from agents WhiteRoom can’t identify are refused fleet-wide while a Block-mode rule blocks, pauses or stops calls.';

export const SETUP_GUIDE_URL = 'https://whiteroom.tech/docs.html';
