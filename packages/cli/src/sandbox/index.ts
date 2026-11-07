// `whiteroom sandbox`: the helper behind the Sandbox page's Run agent button.
// Usage problems exit 2; so does anything unexpected.

import { parseArgs } from "node:util";
import { listen } from "./listen.js";
import { warn } from "../practice/text.js";

export const SANDBOX_USAGE = `whiteroom sandbox — run your agent from the Sandbox page

Usage:
  whiteroom sandbox listen --adapter "<command>" [--code-stdin] [--url <https url>]

  listen    Connects this computer to your Sandbox with the helper code from
            the Sandbox page (Run agent), then runs each task sent from that
            page through your adapter until you press Ctrl+C. Your agent's
            calls go to your Sandbox URL: set its base URL first, for example
            export ANTHROPIC_BASE_URL=<Sandbox URL>.

Options:
  --adapter "<command>"  The command that starts your agent's adapter, e.g. "node wr-adapter.mjs"
                         (the same JSON-lines contract as practice tests: whiteroom practice adapter --lang js)
  --code-stdin           Read the helper code from stdin instead of asking for it
  --url <https url>      Only for testing WhiteRoom itself (a whiteroom.tech address or localhost)

Exit codes: 0 stopped with Ctrl+C, 2 a setup or usage problem, 3 the session ended (get a new code).
`;

function usage(problem?: string): number {
  if (!problem) return process.stdout.write(SANDBOX_USAGE), 0;
  warn(`${problem}\nRun whiteroom sandbox --help to see the commands.`);
  return 2;
}

export async function sandbox(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") return usage();
  if (sub !== "listen") return usage(`Unknown sandbox command: ${sub}`);
  let values: { adapter?: string; "code-stdin"?: boolean; url?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: rest,
      strict: true,
      allowPositionals: false,
      options: { adapter: { type: "string" }, "code-stdin": { type: "boolean" }, url: { type: "string" }, help: { type: "boolean", short: "h" } },
    }));
  } catch (err) {
    return usage((err as Error).message);
  }
  if (values.help) return usage();
  if (!values.adapter?.trim()) return usage("--adapter needs the command that starts your adapter.");
  try {
    return await listen({ adapter: values.adapter, codeStdin: !!values["code-stdin"], url: values.url });
  } catch (err) {
    // Any adapter still running is killed as the process exits (adapter.ts).
    warn(`Something went wrong in the CLI: ${(err as Error)?.message ?? String(err)}`);
    return 2;
  }
}
