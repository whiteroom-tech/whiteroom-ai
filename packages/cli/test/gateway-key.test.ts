// `whiteroom gateway-key new` (signed agent names spec, section 8).

import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { gatewayKey, kidOf } from "../src/gateway-key/index.js";

describe("gateway-key new", () => {
  const dir = mkdtempSync(join(tmpdir(), "wr-gwkey-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (argv: string[]) => {
    const out: string[] = [], err: string[] = [];
    const code = gatewayKey(argv, (l) => out.push(l), (l) => err.push(l));
    return { code, out: out.join("\n"), err: err.join("\n") };
  };

  it("writes a working Ed25519 pair, private.pem readable by its owner only, and never prints the private key", () => {
    const r = run(["new", "--out", dir]);
    assert.equal(r.code, 0);
    const privatePem = readFileSync(join(dir, "private.pem"), "utf8");
    const publicPem = readFileSync(join(dir, "public.pem"), "utf8");
    if (process.platform !== "win32") assert.equal(statSync(join(dir, "private.pem")).mode & 0o777, 0o600);
    assert.match(publicPem, /^-----BEGIN PUBLIC KEY-----\n/);
    const priv = createPrivateKey(privatePem);
    const pub = createPublicKey(publicPem);
    assert.equal(pub.asymmetricKeyType, "ed25519");
    const msg = Buffer.from("whiteroom-agent-v1");
    assert.ok(verify(null, msg, pub, sign(null, msg, priv)));
    assert.ok(!r.out.includes("PRIVATE"));
    assert.ok(!r.out.includes(privatePem.split("\n")[1]));
    assert.match(r.out, /Wrote .*private\.pem\nWrote .*public\.pem\nKey id: [0-9a-f]{16}\nKeep private\.pem on the gateway only\. Paste public\.pem on Fleet key\./);
    const raw = Buffer.from(pub.export({ format: "jwk" }).x as string, "base64url");
    assert.ok(r.out.includes(`Key id: ${kidOf(raw)}`));
  });

  it("never writes over an existing key", () => {
    const before = readFileSync(join(dir, "private.pem"), "utf8");
    const r = run(["new", "--out", dir]);
    assert.equal(r.code, 1);
    assert.match(r.err, /private\.pem already exists\. Move it, or pass --out <dir>\./);
    assert.equal(readFileSync(join(dir, "private.pem"), "utf8"), before);
  });

  it("says how to use it, and refuses what it doesn't know", () => {
    const help = run(["--help"]);
    assert.equal(help.code, 0);
    assert.match(help.out, /gateway-key new/);
    assert.equal(run([]).code, 1);
    assert.match(run(["rotate"]).err, /Unknown gateway-key command: rotate/);
    assert.match(run(["new", "--force"]).err, /Unknown option: --force/);
    const other = mkdtempSync(join(tmpdir(), "wr-gwkey-"));
    writeFileSync(join(other, "public.pem"), "x");
    const r = run(["new", "--out", other]);
    assert.equal(r.code, 1);
    assert.match(r.err, /public\.pem already exists/);
    // Nothing half-written.
    assert.throws(() => readFileSync(join(other, "private.pem")));
    assert.equal(run(["new", "--out"]).err, "--out needs a folder.");
    rmSync(other, { recursive: true, force: true });
  });
});
