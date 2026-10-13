#!/usr/bin/env bash
# Copies the engine's practice-test contract (catalog.json, contract.json) into
# packages/cli/contract, the one copy the CLI ships and the dashboard imports,
# and records the engine commit and each file's sha256 in SOURCE.txt (checked
# by packages/cli/test/contract.test.ts, so a hand edit fails CI).
#
#   ENGINE_DIR=<a checkout of the engine> scripts/sync-practice-contract.sh <engine-sha>
set -euo pipefail
sha="${1:?usage: ENGINE_DIR=<engine checkout> $0 <engine-sha>}"
: "${ENGINE_DIR:?set ENGINE_DIR to a checkout of the engine}"
out="$(cd "$(dirname "$0")/.." && pwd)/packages/cli/contract"
full="$(git -C "$ENGINE_DIR" rev-parse --verify "$sha^{commit}")"
for f in catalog.json contract.json; do
  git -C "$ENGINE_DIR" show "$full:apps/engine/fixtures/readiness/$f" > "$out/$f"
done
{
  echo "Copied unchanged from the engine's practice-test fixtures (apps/engine/fixtures/readiness)."
  echo "Refresh with scripts/sync-practice-contract.sh; never edit these files by hand."
  echo "engine $full"
  for f in catalog.json contract.json; do echo "sha256 $f $(shasum -a 256 "$out/$f" | cut -d' ' -f1)"; done
} > "$out/SOURCE.txt"
echo "Synced $out from engine ${full:0:8}."
