// The engine's practice-test catalog (contract/catalog.json): the CLI ships it
// and the dashboard imports the same file, so task, status, provider and
// refusal words are the engine's. Refreshed by scripts/sync-practice-contract.sh.

import { readFileSync } from "node:fs";

/** A provider's name, its key's variable, the header the key travels in (`bearer`: Authorization: Bearer) and its API. */
export interface ProviderInfo { label: string; keyVar: string; header: "x-api-key" | "api-key" | "bearer"; api: "messages" | "chat_completions" }

export const CATALOG = JSON.parse(readFileSync(new URL("../../contract/catalog.json", import.meta.url), "utf8")) as {
  taskNames: Record<string, string>; disclaimer: string; providers: Record<string, ProviderInfo>; keyRefusals: Record<string, string>; runCallCap: number;
  statusLabels: Record<"passed" | "failed" | "not_tested" | "unsupported" | "error", string>; verdictLabels: Record<"passed" | "not_passed" | "incomplete", string>;
};
