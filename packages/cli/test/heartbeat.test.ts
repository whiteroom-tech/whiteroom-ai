// The heartbeat (every 30 s, spec §4 Practice tasks 6) can end the test on
// its own: in its own file so its half-minute wait runs alongside the others.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { alive, cli, fixture, startStub } from "./stub.js";

it("WhiteRoom ending the test on a heartbeat stops the adapter's group and exits 3", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "wr-cli-hb-"));
  const pidFile = join(dir, "hb.pid");
  const adapter = join(dir, "hang.mjs");
  writeFileSync(adapter, `
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
    setInterval(() => {}, 1000);
  `);
  const s = await startStub({ taskMs: 120_000, route: (p) => (p === "/api/readiness/heartbeat" ? [409, fixture("session.ended_by_owner").response] : undefined) });
  try {
    const r = await cli(["practice", "run", "--code-stdin", "--url", s.url, "--adapter", `node ${adapter}`]);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /ended from the dashboard/);
    assert.equal(s.count("/api/readiness/heartbeat"), 1);
    assert.ok(existsSync(pidFile));
    assert.equal(alive(Number(readFileSync(pidFile, "utf8"))), false);
  } finally {
    await s.close();
  }
});
