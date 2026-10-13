// `whiteroom practice` (hidden alias `readiness`), spec §10 CLI. Usage
// problems exit 2, never 1 (§8); so does anything unexpected.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { practiceRun, STARTERS_DIR } from "./run.js";
import { warn } from "./text.js";

export const PRACTICE_USAGE = `whiteroom practice — run a WhiteRoom practice test on your agent

Usage:
  whiteroom practice run [--adapter "<command>"] [--code-stdin] [--url <https url>]
  whiteroom practice adapter --lang js|python

  run       Starts the practice test from the run code shown in the dashboard.
            Without --adapter, WhiteRoom's sample agent runs the practice tasks.
  adapter   Prints a starter adapter to connect your own agent, for example:
            whiteroom practice adapter --lang js > wr-adapter.mjs

Options:
  --adapter "<command>"  The command that starts your agent's adapter, e.g. "node wr-adapter.mjs"
  --code-stdin           Read the run code from stdin instead of asking for it
  --url <https url>      Only for testing WhiteRoom itself
`;

const STARTERS = { js: "wr-adapter.mjs", python: "wr_adapter.py" } as const;

function usage(problem?: string): number {
  if (!problem) return process.stdout.write(PRACTICE_USAGE), 0;
  warn(`${problem}\nRun whiteroom practice --help to see the commands.`);
  return 2;
}

export async function practice(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") return usage();
  let values: { adapter?: string; "code-stdin"?: boolean; url?: string; lang?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: rest,
      strict: true,
      allowPositionals: false,
      options: sub === "run"
        ? { adapter: { type: "string" }, "code-stdin": { type: "boolean" }, url: { type: "string" }, help: { type: "boolean", short: "h" } }
        : { lang: { type: "string" }, help: { type: "boolean", short: "h" } },
    }));
  } catch (err) {
    return usage((err as Error).message);
  }
  if (values.help) return usage();
  try {
    if (sub === "run") {
      if (values.adapter !== undefined && !values.adapter.trim()) return usage("--adapter needs the command that starts your adapter.");
      return await practiceRun({ adapter: values.adapter, codeStdin: !!values["code-stdin"], url: values.url });
    }
    if (sub === "adapter") {
      const file = STARTERS[values.lang as keyof typeof STARTERS];
      if (!file) return usage("Choose a starter with --lang js or --lang python.");
      process.stdout.write(readFileSync(new URL(file, STARTERS_DIR), "utf8"));
      return 0;
    }
    return usage(`Unknown practice command: ${sub}`);
  } catch (err) {
    // Any adapter still running is killed as the process exits (adapter.ts).
    warn(`Something went wrong in the CLI: ${(err as Error)?.message ?? String(err)}`);
    return 2;
  }
}
