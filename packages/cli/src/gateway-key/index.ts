// `whiteroom gateway-key new` (signed agent names spec, section 8): makes the
// Ed25519 key pair a gateway signs agent names with. private.pem stays on the
// gateway (mode 0600); public.pem is pasted on Fleet key. The private key is
// never printed. Plain Node, no SDK.

import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const GATEWAY_KEY_USAGE = `Usage:
  whiteroom gateway-key new [--out <dir>]

Makes private.pem and public.pem in <dir> (default: this folder).`;

/** The key id the dashboard shows: the first 16 hex characters of the SHA-256 of the raw 32-byte public key. */
export function kidOf(raw: Buffer): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

export function gatewayKey(argv: string[], out: (line: string) => void = console.log, err: (line: string) => void = console.error): number {
  const [sub, ...rest] = argv;
  if (sub === "help" || sub === "--help") { out(GATEWAY_KEY_USAGE); return 0; }
  if (sub !== "new") {
    err(sub === undefined ? GATEWAY_KEY_USAGE : `Unknown gateway-key command: ${sub}\n\n${GATEWAY_KEY_USAGE}`);
    return 1;
  }
  let dir = ".";
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--out") {
      if (!rest[i + 1]) { err("--out needs a folder."); return 1; }
      dir = rest[++i];
    } else { err(`Unknown option: ${rest[i]}\n\n${GATEWAY_KEY_USAGE}`); return 1; }
  }
  const privatePath = resolve(dir, "private.pem");
  const publicPath = resolve(dir, "public.pem");
  // Neither file is written if either exists: a gateway may still be using that key.
  for (const path of [privatePath, publicPath]) {
    if (existsSync(path)) { err(`${path} already exists. Move it, or pass --out <dir>.`); return 1; }
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicPem = publicKey.export({ format: "pem", type: "spki" }) as string;
  const privatePem = privateKey.export({ format: "pem", type: "pkcs8" }) as string;
  try {
    // "wx": never over an existing key, which a gateway may still be using.
    writeFileSync(privatePath, privatePem, { mode: 0o600, flag: "wx" });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    err(code === "EEXIST" ? `${privatePath} already exists. Move it, or pass --out <dir>.` : `Couldn't write ${privatePath}: ${(e as Error).message}`);
    return 1;
  }
  try {
    writeFileSync(publicPath, publicPem, { mode: 0o644, flag: "wx" });
  } catch (e) {
    // No half-made pair: the private key goes too, so the next run starts clean.
    try { unlinkSync(privatePath); } catch { /* already gone */ }
    const code = (e as NodeJS.ErrnoException).code;
    err(code === "EEXIST" ? `${publicPath} already exists. Move it, or pass --out <dir>.` : `Couldn't write ${publicPath}: ${(e as Error).message}`);
    return 1;
  }
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  out(`Wrote ${privatePath}`);
  out(`Wrote ${publicPath}`);
  out(`Key id: ${kidOf(raw)}`);
  out("Keep private.pem on the gateway only. Paste public.pem on Fleet key.");
  return 0;
}
