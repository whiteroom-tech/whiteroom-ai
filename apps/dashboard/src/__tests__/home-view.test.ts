import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));

import { HomeView, weekRules, weekSentence } from "@/components/home/HomeContent";
import type { AgentInfo, FleetReport } from "@/lib/whiteroom/types";
import type { ChangeRow } from "@/lib/home-changes";

const REPORT: FleetReport = {
  fleetId: "acme", agentCount: 1, holds: {},
  status: { working: [], resting: [], idle: ["code-reviewer"], handover_out: [] },
  totals: { workMinutes: 0, tokens: 0, tasks: 0, handovers: 0 },
  energySavings: { compressionRatio: 0, estimatedTokensSaved: 0, estimatedCostSaved: "$0", totalCostSaved: "$12.3100", estimatedEnergySaved: "0 kWh", formula: "" },
  compliance: { allAgentsWithinLimits: true, restingAgentsCount: 0, laborScore: "100%" },
};
const AGENT: AgentInfo = { agentId: "code-reviewer", status: "idle", currentShift: null, lastShift: { watchNumber: 4, tasksCompleted: 6, tokensUsed: 0, minutesWorked: 0 } };
const tally = (blocks: number, wouldBlocks: number) => ({ blocks, wouldBlocks, paused: 0, stopped: 0, toldYou: 0 });
const WEEK = {
  calls: 10, costUsd: 3.17, partial: false, rules: tally(0, 120),
  agents: { "code-reviewer": { used: 53_400, input: 412_000, saved: 225_800, rules: tally(0, 60), score: { agentId: "code-reviewer", calls: 4, completeRate: 100, costDiligence: null, speedScore: 57, score: 8 } } },
};

const home = (over: Partial<Parameters<typeof HomeView>[0]> = {}) => renderToStaticMarkup(createElement(HomeView, {
  report: REPORT, agents: [AGENT], changes: [], today: { calls: 0, costUsd: 0 }, failing: false, view: "cards", onViewChange: () => {}, liveFeed: null,
  week: WEEK, todayRules: tally(0, 0), flaggedToday: 0, lastActive: { day: "2026-10-24", runs: 47 }, ...over,
})).replace(/<!-- -->/g, "");
/** The rendered text, as a reader sees it (parsed, not regex-stripped). */
const text = (html: string) => { const el = new Window().document.createElement("div"); el.innerHTML = html; return el.textContent ?? ""; };

describe("Home (mockup parity)", () => {
  it("opens with the fact line, not Needs you", () => {
    const t = text(home());
    expect(t).toContain("No agents on hold · 0 flagged runs today · rules caught 0 times today · Last 7 days →");
    expect(t).not.toContain("Nothing needs you");
  });

  it("names held agents in the fact line, with a link each", () => {
    const held = { ...AGENT, hold: { state: "paused" as const, by: "user:u1", reason: null, at: "2026-10-27T10:00:00Z" } };
    const html = home({ agents: [held], report: { ...REPORT, holds: { "code-reviewer": held.hold } } });
    expect(text(html)).toContain("1 agent on hold: code-reviewer (paused)");
    expect(html).toContain('href="/agents/code-reviewer"');
  });

  it("shows the quiet-day box with the last active day", () => {
    expect(text(home())).toContain("Quiet so far today. Last activity Sat, Oct 24: 47 runs. This week: $3.17 spent, rules would have acted 120 times. View runs →");
  });

  it("an agent card has a score ring, a link to its last run, and its week", () => {
    const html = home();
    expect(html).toContain('aria-label="Score 8 out of 10"');
    expect(html).toContain('href="/runs/code-reviewer~4"');
    expect(text(html)).toContain("Last run #4 · 6 tasks · waiting for work");
    expect(text(html)).toContain("412K input sent · 226K input saved · 60 would have acted");
    expect(text(html)).toContain("Waiting");
  });

  it("the table has a Last run column, the ring with speed, and real links", () => {
    const html = home({ view: "table" });
    expect(text(html)).toContain("Last run");
    expect(html).toContain('href="/runs/code-reviewer~4"');
    expect(html).toContain('href="/agents/code-reviewer"');
    expect(text(html)).toContain("Speed 5.7");
  });

  it("lists latest changes as links, says Loading before the first read and when there are none", () => {
    const rows: ChangeRow[] = [{ key: "1", time: "10:30 am", text: "Loop breaker rule added by R Haque", href: "/controls?rule=gr_1" }];
    expect(home({ changes: rows })).toContain('href="/controls?rule=gr_1"');
    expect(text(home({ changes: null }))).toContain("Loading…");
    expect(text(home({ changes: null, changesFailing: true }))).toContain("Couldn’t load changes. Retrying…");
    expect(text(home({ changes: [] }))).toContain("No rule or agent changes yet.");
  });

  it("closes with View runs and Check audit trail, and says nothing about how WhiteRoom works", () => {
    const t = text(home());
    expect(t).toContain("Calls through WhiteRoom are recorded · View runs → · Check audit trail");
    expect(t).toContain("$12.31 saved all time, est. →");
    expect(t).toContain("no calls yet today");
    expect(t).toContain("1 waiting for work");
    expect(t).not.toMatch(/break|handover|notes|resting|saving progress/i);
  });

  it("words the week's rules", () => {
    expect(weekRules(tally(2, 0))).toBe("rules blocked 2 calls");
    expect(weekRules(tally(0, 0))).toBe("no rule activity");
    // Spend and rules are said each when known.
    expect(weekSentence({ ...WEEK, costUsd: null })).toBe("rules would have acted 120 times");
    expect(weekSentence({ ...WEEK, rules: null })).toBe("$3.17 spent");
    expect(weekSentence({ ...WEEK, costUsd: null, rules: null })).toBe("");
    expect(weekRules({ blocks: 0, wouldBlocks: 0, paused: 2, stopped: 0, toldYou: 1 })).toBe("rules acted 3 times");
  });

  it("counts only calls as calls in the fact line", () => {
    const t = text(home({ todayRules: { blocks: 1, wouldBlocks: 4, paused: 2, stopped: 0, toldYou: 1 } }));
    expect(t).toContain("rules caught 5 times today, 1 blocked, and acted 3 other times");
    expect(text(home({ todayRules: tally(0, 4) }))).toContain("rules caught 4 times today, 0 blocked ·");
  });
});

describe("Home audit check wording", () => {
  it("is green only for a whole, clean check", async () => {
    const { auditCheckText } = await import("@/components/home/AuditCheckDialog");
    const info = { fleetId: "f", mode: "sequenced" as const, headSeq: 2045, verifiedThroughSeq: 939, verifiedAt: null, prunedBeforeTracking: true, legacyEvents: 0, gaps: { count: 0, recent: [] }, anchoring: { enabled: false } };
    expect(auditCheckText({ valid: true, complete: true, eventsVerified: 2045, message: "" }, { ...info, verifiedThroughSeq: 2045 })).toMatchObject({ tone: "ok", title: "Nothing changed or missing" });
    expect(auditCheckText({ valid: true, eventsVerified: 939, message: "" }, info)).toMatchObject({ tone: "neutral", detail: "Verified through event 939 of 2,045. Events before tracking started aren’t covered. The rest hasn’t been checked yet." });
    expect(auditCheckText({ valid: false, eventsVerified: 3, message: "Event 4 was changed." }, info)).toMatchObject({ tone: "bad", detail: "Event 4 was changed." });
  });
});
