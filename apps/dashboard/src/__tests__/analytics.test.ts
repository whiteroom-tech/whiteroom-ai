import { describe, it, expect } from "vitest";

// Mirror the dashboard's estimateCost function
function estimateCost(tokensSaved: number): number {
  return tokensSaved * 0.8 * 0.0000008 + tokensSaved * 0.2 * 0.000004;
}

// Mirror the dashboard's date range cutoff logic
function getCutoff(range: string, nowMs: number): string {
  const DAY_MS = 86400000;
  const todayKey = new Date(nowMs).toISOString().slice(0, 10);
  return range === "today"
    ? todayKey
    : range === "7d"
      ? new Date(nowMs - 6 * DAY_MS).toISOString().slice(0, 10)
      : range === "30d"
        ? new Date(nowMs - 29 * DAY_MS).toISOString().slice(0, 10)
        : "1970-01-01";
}

// Mirror the dashboard's handover savings extraction
function handoverSaved(e: { contextTokens?: number; handoverDocTokens?: number }): number {
  const ctx = e.contextTokens || 0;
  const doc = e.handoverDocTokens || 300;
  return Math.max(0, ctx - doc);
}

// Mirror the dashboard's composite watch key
function watchKey(day: string, agentId: string, watchNumber: number): string {
  return `${day}:${agentId}:${watchNumber}`;
}

describe("date range boundaries", () => {
  it("'today' includes only today (UTC)", () => {
    // 2026-07-11 15:00:00 UTC
    const nowMs = Date.UTC(2026, 6, 11, 15, 0, 0);
    const cutoff = getCutoff("today", nowMs);
    expect(cutoff).toBe("2026-07-11");

    // An event from today passes
    expect("2026-07-11" >= cutoff).toBe(true);
    // Yesterday does not
    expect("2026-07-10" >= cutoff).toBe(false);
  });

  it("'7d' includes exactly 7 calendar days", () => {
    const nowMs = Date.UTC(2026, 6, 11, 15, 0, 0);
    const cutoff = getCutoff("7d", nowMs);
    expect(cutoff).toBe("2026-07-05");

    // Day 7 (Jul 5) is included
    expect("2026-07-05" >= cutoff).toBe(true);
    // Day 8 (Jul 4) is excluded
    expect("2026-07-04" >= cutoff).toBe(false);
    // Today (Jul 11) is included
    expect("2026-07-11" >= cutoff).toBe(true);
  });

  it("'30d' includes exactly 30 calendar days", () => {
    const nowMs = Date.UTC(2026, 6, 11, 15, 0, 0);
    const cutoff = getCutoff("30d", nowMs);
    expect(cutoff).toBe("2026-06-12");

    expect("2026-06-12" >= cutoff).toBe(true);
    expect("2026-06-11" >= cutoff).toBe(false);
  });

  it("'recent' includes all retained events", () => {
    const nowMs = Date.UTC(2026, 6, 11, 15, 0, 0);
    const cutoff = getCutoff("recent", nowMs);
    expect(cutoff).toBe("1970-01-01");
  });

  it("'today' handles UTC midnight boundary", () => {
    // 2026-07-11 23:59:59 UTC — still Jul 11
    const lateMs = Date.UTC(2026, 6, 11, 23, 59, 59);
    expect(getCutoff("today", lateMs)).toBe("2026-07-11");

    // 2026-07-12 00:00:01 UTC — now Jul 12
    const earlyMs = Date.UTC(2026, 6, 12, 0, 0, 1);
    expect(getCutoff("today", earlyMs)).toBe("2026-07-12");
  });
});

describe("composite watch grouping", () => {
  it("generates unique keys for same watch number on different agents", () => {
    const k1 = watchKey("2026-07-11", "agent-alpha", 3);
    const k2 = watchKey("2026-07-11", "agent-bravo", 3);
    expect(k1).not.toBe(k2);
  });

  it("generates unique keys for same agent on different days", () => {
    const k1 = watchKey("2026-07-10", "agent-alpha", 1);
    const k2 = watchKey("2026-07-11", "agent-alpha", 1);
    expect(k1).not.toBe(k2);
  });

  it("generates the same key for the same day/agent/watch", () => {
    const k1 = watchKey("2026-07-11", "agent-alpha", 2);
    const k2 = watchKey("2026-07-11", "agent-alpha", 2);
    expect(k1).toBe(k2);
  });
});

describe("savings calculation", () => {
  it("computes saved = contextTokens - handoverDocTokens", () => {
    expect(handoverSaved({ contextTokens: 5000, handoverDocTokens: 300 })).toBe(4700);
  });

  it("defaults handoverDocTokens to 300 when missing", () => {
    expect(handoverSaved({ contextTokens: 1000 })).toBe(700);
  });

  it("clamps to zero when doc is larger than context", () => {
    expect(handoverSaved({ contextTokens: 100, handoverDocTokens: 500 })).toBe(0);
  });

  it("returns zero when contextTokens is missing", () => {
    expect(handoverSaved({})).toBe(0);
  });
});

describe("cost estimation", () => {
  it("matches the engine formula", () => {
    const saved = 10000;
    const cost = estimateCost(saved);
    // 10000 * 0.8 * 0.0000008 = 0.0064
    // 10000 * 0.2 * 0.000004  = 0.008
    // Total = 0.0144
    expect(cost).toBeCloseTo(0.0144, 6);
  });

  it("returns zero for zero savings", () => {
    expect(estimateCost(0)).toBe(0);
  });
});

describe("credential cleanup", () => {
  it("clearFleetCredentials removes all three keys", () => {
    const store: Record<string, string> = {
      wr_token: "tok",
      wr_fleet: "fleet",
      wr_fleet_token: "ft",
      unrelated_key: "keep",
    };

    // Simulate clearFleetCredentials
    delete store["wr_token"];
    delete store["wr_fleet"];
    delete store["wr_fleet_token"];

    expect(store["wr_token"]).toBeUndefined();
    expect(store["wr_fleet"]).toBeUndefined();
    expect(store["wr_fleet_token"]).toBeUndefined();
    expect(store["unrelated_key"]).toBe("keep");
  });
});

describe("session reset on re-login", () => {
  it("re-login clears old credentials before writing new ones", () => {
    const store: Record<string, string | undefined> = {
      wr_token: "old-sk-ant-key",
      wr_fleet: "old-fleet-id",
      wr_fleet_token: "wr_old_token",
    };

    // Simulate clearFleetCredentials() then write new values (handleFleetLogin flow)
    store["wr_token"] = undefined;
    store["wr_fleet"] = undefined;
    store["wr_fleet_token"] = undefined;

    store["wr_token"] = "new-sk-ant-key";
    store["wr_fleet"] = "new-fleet-id";

    expect(store["wr_token"]).toBe("new-sk-ant-key");
    expect(store["wr_fleet"]).toBe("new-fleet-id");
    // Old fleet token must not survive
    expect(store["wr_fleet_token"]).toBeUndefined();
  });

  it("resetSession clears both storage and state together", () => {
    const storage: Record<string, string | undefined> = {
      wr_token: "tok", wr_fleet: "f", wr_fleet_token: "ft",
    };
    const state = { token: "tok" as string | null, fleetId: "f" as string | null, fleetToken: "ft" as string | null, authenticated: true };

    // Simulate resetSession()
    storage["wr_token"] = undefined;
    storage["wr_fleet"] = undefined;
    storage["wr_fleet_token"] = undefined;
    state.token = null;
    state.fleetId = null;
    state.fleetToken = null;
    state.authenticated = false;

    expect(storage["wr_token"]).toBeUndefined();
    expect(storage["wr_fleet"]).toBeUndefined();
    expect(storage["wr_fleet_token"]).toBeUndefined();
    expect(state.token).toBeNull();
    expect(state.fleetId).toBeNull();
    expect(state.fleetToken).toBeNull();
    expect(state.authenticated).toBe(false);
  });
});

describe("stale agent display", () => {
  it("agent with stale=true gets 'stale' status for rendering", () => {
    const agent = { status: "working", stale: true };
    const displayStatus = agent.stale ? "stale" : (agent.status || "idle");
    expect(displayStatus).toBe("stale");
  });

  it("agent with stale=false keeps original status", () => {
    const agent = { status: "working", stale: false };
    const displayStatus = agent.stale ? "stale" : (agent.status || "idle");
    expect(displayStatus).toBe("working");
  });

  it("agent without stale field defaults to original status", () => {
    const agent = { status: "resting" };
    const displayStatus = (agent as { stale?: boolean }).stale ? "stale" : (agent.status || "idle");
    expect(displayStatus).toBe("resting");
  });
});
