#!/usr/bin/env node
import { parseArgs as parseArgv } from "node:util";

const USAGE = `whiteroom — CLI for WhiteRoom agent governance

Usage:
  whiteroom health
  whiteroom register <agent_id> [--fleet <id>] [--role <role>]
  whiteroom pair <agent_a> <agent_b> [--fleet <id>]
  whiteroom auto-pair [--fleet <id>]
  whiteroom start <agent_id> [--fleet <id>]
  whiteroom task <agent_id> <task_name> [--minutes <n>] [--tokens <n>] [--fleet <id>]
  whiteroom check <agent_id> [--fleet <id>]
  whiteroom handover <from_agent> <to_agent> [--fleet <id>]
  whiteroom alarm <agent_id> [--fleet <id>]
  whiteroom report [--fleet <id>]
  whiteroom fleets
  whiteroom login <fleet_token>
  whiteroom practice run [--adapter "<command>"] [--code-stdin]
  whiteroom practice adapter --lang js|python

Options:
  --url <base_url>   Server URL (default: WHITEROOM_URL or http://localhost:3000)
  --key <api_key>    API key (default: WHITEROOM_API_KEY)
`;

// The fleet commands' flags; anything else is ignored, as before.
const LEGACY_FLAGS = ["url", "key", "fleet", "role", "minutes", "tokens"] as const;

function parseArgs(argv: string[]) {
  const { values, positionals } = parseArgv({
    args: argv,
    strict: false,
    allowPositionals: true,
    options: Object.fromEntries(LEGACY_FLAGS.map((f) => [f, { type: "string" as const }])),
  });
  const flags: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) if (typeof v === "string") flags[k] = v;
  return { args: positionals, flags };
}

async function main() {
  const argv = process.argv.slice(2);
  // Practice tests never load the SDK (spec §9.5): plain fetch only.
  if (argv[0] === "practice" || argv[0] === "readiness") {
    const { practice } = await import("./practice/index.js");
    process.exitCode = await practice(argv.slice(1));
    return;
  }
  const { args, flags } = parseArgs(argv);
  const command = args[0];

  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    process.exit(0);
  }

  const { WhiteRoomClient, WhiteRoomError } = await import("@whiteroom-ai/sdk");
  const client = new WhiteRoomClient({
    baseUrl: flags.url ?? process.env.WHITEROOM_URL ?? "http://localhost:3000",
    apiKey: flags.key ?? process.env.WHITEROOM_API_KEY,
  });

  try {
    switch (command) {
      case "health":
        print(await client.health());
        break;

      case "register":
        requireArg(args[1], "agent_id");
        print(await client.registerAgent(args[1], { fleetId: flags.fleet, role: flags.role }));
        break;

      case "pair":
        requireArg(args[1], "agent_a");
        requireArg(args[2], "agent_b");
        print(await client.pairAgents(args[1], args[2], flags.fleet));
        break;

      case "auto-pair":
        print(await client.autoPair(flags.fleet));
        break;

      case "start":
        requireArg(args[1], "agent_id");
        print(await client.startWatch(args[1], flags.fleet));
        break;

      case "task":
        requireArg(args[1], "agent_id");
        requireArg(args[2], "task_name");
        print(
          await client.completeTask(args[1], args[2], {
            fleetId: flags.fleet,
            minutesSpent: flags.minutes ? Number(flags.minutes) : undefined,
            tokensUsed: flags.tokens ? Number(flags.tokens) : undefined,
          })
        );
        break;

      case "check":
        requireArg(args[1], "agent_id");
        print(await client.checkWatch(args[1], flags.fleet));
        break;

      case "handover":
        requireArg(args[1], "from_agent");
        requireArg(args[2], "to_agent");
        print(await client.initiateHandover(args[1], args[2], { fleetId: flags.fleet }));
        break;

      case "alarm":
        requireArg(args[1], "agent_id");
        print(await client.fireAlarm(args[1], flags.fleet));
        break;

      case "report":
        print(await client.fleetReport(flags.fleet));
        break;

      case "fleets":
        print(await client.listFleets());
        break;

      case "login":
        requireArg(args[1], "fleet_token");
        print(await client.tokenLogin(args[1]));
        break;

      default:
        console.error(`Unknown command: ${command}\n`);
        console.log(USAGE);
        process.exit(1);
    }
  } catch (e) {
    if (e instanceof WhiteRoomError) {
      console.error(`Error ${e.status}: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}

function requireArg(value: string | undefined, name: string): asserts value is string {
  if (!value) {
    console.error(`Missing required argument: <${name}>`);
    process.exit(1);
  }
}

function print(data: unknown) {
  console.log(JSON.stringify(data, null, 2));
}

main();
