import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));

import { HomeView } from "@/components/home/HomeContent";
import type { AuditEntry, FleetReport } from "@/lib/whiteroom/types";

const REPORT: FleetReport = {
  fleetId: "acme", agentCount: 0,
  status: { working: [], resting: [], idle: [], handover_out: [] },
  totals: { workMinutes: 0, tokens: 0, tasks: 0, handovers: 0 },
  energySavings: { compressionRatio: 0, estimatedTokensSaved: 0, estimatedCostSaved: "$0", estimatedEnergySaved: "0 kWh", formula: "" },
  compliance: { allAgentsWithinLimits: true, restingAgentsCount: 0, laborScore: "100%" },
};

const home = (entries: AuditEntry[] | null, failing = false) => renderToStaticMarkup(createElement(HomeView, {
  report: REPORT, agents: [], entries, today: null, failing, view: "cards", onViewChange: () => {}, liveFeed: null,
}));

const EMPTY = "Nothing yet. Events appear here as your agents work.";

describe("Home activity before the first load", () => {
  // The report can land before the audit log; Home must not claim there is no activity yet.
  it("says Loading, not Nothing yet, while activity hasn't loaded", () => {
    const html = home(null);
    expect(html).toContain("Loading…");
    expect(html).not.toContain(EMPTY);
  });

  it("says it's retrying when the first activity load failed", () => {
    expect(home(null, true)).toContain("Couldn’t load activity. Retrying…");
  });

  it("shows the empty line once activity loaded with nothing in it", () => {
    expect(home([])).toContain(EMPTY);
  });
});
