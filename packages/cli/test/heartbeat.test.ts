// The heartbeat (every 30 s, spec §4 Practice tasks 6) can end the test on
// its own: in its own file so its half-minute waits run alongside the others.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { alive, cli, finishedNotPassed, fixture, startStub } from "./stub.js";

/** A heartbeat answered with `reply` while the adapter hangs (with a grandchild in its group). */
async function heartbeatSays(reply: [number, unknown]) {
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
  const s = await startStub({ taskMs: 120_000, route: (p) => (p === "/api/readiness/heartbeat" ? reply : undefined) });
  try {
    const r = await cli(["practice", "run", "--code-stdin", "--url", s.url, "--adapter", `node ${adapter}`]);
    assert.equal(s.count("/api/readiness/heartbeat"), 1);
    assert.ok(existsSync(pidFile));
    assert.equal(alive(Number(readFileSync(pidFile, "utf8"))), false);
    return { r, s };
  } finally {
    await s.close();
  }
}

describe("the heartbeat", { concurrency: true }, () => {
  it("WhiteRoom ending the test on a heartbeat stops the adapter's group and exits 3", { timeout: 60_000 }, async () => {
    const { r } = await heartbeatSays([409, fixture("session.ended_by_owner").response]);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /ended from the dashboard/);
  });

  it("a heartbeat saying the run already finished stops the adapter and shows the result", { timeout: 60_000 }, async () => {
    const { r, s } = await heartbeatSays([200, fixture("tasks.next.done").response]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Passed · all \d+ checks · 3 runs/);
    assert.doesNotMatch(r.stderr, /was updated/);
    assert.deepEqual(s.cancels, []);
  });

  it("a heartbeat's 409 finished with the result exits by its verdict", { timeout: 60_000 }, async () => {
    const { r } = await heartbeatSays([409, finishedNotPassed()]);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stdout, /Didn't pass · 1 check failed/);
  });

  it("a heartbeat's 409 finished without the result gets it from tasks/next", { timeout: 60_000 }, async () => {
    const { r, s } = await heartbeatSays([409, fixture("session.finished").response]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Passed · all \d+ checks · 3 runs/);
    assert.equal(s.count("/api/readiness/tasks/next"), 2);
  });
});
