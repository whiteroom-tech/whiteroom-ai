// The fleet commands' argument parser, unchanged from before practice tests:
// every `--name` takes the next word as its value, whatever it looks like.
// (Practice commands use node:util parseArgs instead.)
export function parseArgs(argv: string[]) {
  const args: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length) {
      flags[argv[i].slice(2)] = argv[++i];
    } else {
      args.push(argv[i]);
    }
  }
  return { args, flags };
}
