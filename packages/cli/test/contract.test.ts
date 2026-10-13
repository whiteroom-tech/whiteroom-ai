// The practice-test contract (contract/): one copy of the engine's catalog
// and fixtures, shipped by the CLI and imported by the dashboard. SOURCE.txt
// pins the engine commit and each file's sha256, so a hand edit fails here;
// scripts/sync-practice-contract.sh refreshes both together.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { it } from "node:test";

const file = (name: string) => readFileSync(new URL(`../contract/${name}`, import.meta.url));

it("contract/ is exactly what SOURCE.txt says was copied from the engine", () => {
  const source = file("SOURCE.txt").toString();
  assert.match(source, /^engine [0-9a-f]{40}$/m);
  for (const name of ["catalog.json", "contract.json"]) {
    const sha = createHash("sha256").update(file(name)).digest("hex");
    assert.ok(source.includes(`sha256 ${name} ${sha}`), `${name} differs from SOURCE.txt: run scripts/sync-practice-contract.sh`);
  }
  // What the CLI ships: the catalog only (package.json files).
  assert.ok(JSON.parse(file("../package.json").toString()).files.includes("contract/catalog.json"));
});
