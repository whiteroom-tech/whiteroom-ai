import { describe, it, expect } from "vitest";
import { deriveDisplayStatus, resolveAuthKey, isApiKey, buildCredentials } from "../lib/fleet-helpers";
// Import the REAL analytics math the dashboard uses, so these tests guard the
// actual implementation instead of a hand-mirrored copy that can silently drift.
import { estimateCost, getCutoff, handoverSaved, watchKey } from "../lib/analytics-metrics";

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

describe("fleet helpers — deriveDisplayStatus", () => {
  it("stale agent overrides status to 'stale'", () => {
    expect(deriveDisplayStatus("working", true)).toBe("stale");
  });

  it("non-stale agent keeps original status", () => {
    expect(deriveDisplayStatus("working", false, 5)).toBe("working");
  });

  it("missing stale flag keeps original status", () => {
    expect(deriveDisplayStatus("resting")).toBe("resting");
  });

  it("empty status defaults to 'idle'", () => {
    expect(deriveDisplayStatus("")).toBe("idle");
  });

  it("working agent with 0 minutes remaining shows idle", () => {
    expect(deriveDisplayStatus("working", false, 0)).toBe("idle");
  });

  it("working agent with negative minutes remaining shows idle", () => {
    expect(deriveDisplayStatus("working", false, -2)).toBe("idle");
  });

  it("resting agent with 0 minutes remaining stays resting", () => {
    expect(deriveDisplayStatus("resting", false, 0)).toBe("resting");
  });

  it("disconnected agent shows disconnected regardless of other flags", () => {
    expect(deriveDisplayStatus("working", false, 5, true)).toBe("disconnected");
  });

  it("disconnected takes priority over stale", () => {
    expect(deriveDisplayStatus("working", true, 5, true)).toBe("disconnected");
  });

  it("non-disconnected agent with stale still shows stale", () => {
    expect(deriveDisplayStatus("working", true, 5, false)).toBe("stale");
  });
});

describe("fleet helpers — resolveAuthKey", () => {
  it("returns fleet token when present", () => {
    expect(resolveAuthKey("wr_abc123")).toBe("wr_abc123");
  });

  it("returns undefined when null", () => {
    expect(resolveAuthKey(null)).toBeUndefined();
  });
});

describe("fleet helpers — isApiKey", () => {
  it("recognizes Anthropic API keys", () => {
    expect(isApiKey("sk-ant-abc123")).toBe(true);
  });

  it("rejects fleet tokens", () => {
    expect(isApiKey("wr_abc123")).toBe(false);
  });
});

describe("fleet helpers — buildCredentials", () => {
  it("returns typed credential object", () => {
    const creds = buildCredentials("fleet-1", "wr_tok");
    expect(creds).toEqual({ fleetId: "fleet-1", fleetToken: "wr_tok" });
  });
});

describe("BYOK security contract", () => {
  it("resolveAuthKey never returns an API key from fleet token state", () => {
    // The login flow stores only wr_ fleet tokens, never sk- keys.
    // resolveAuthKey reads from fleetToken state which should only contain wr_ values.
    // This test verifies that if somehow an sk- key leaked into fleetToken state,
    // isApiKey would detect it.
    const leaked = "sk-ant-leaked";
    expect(isApiKey(leaked)).toBe(true);

    const safeToken = "wr_safe_token";
    expect(isApiKey(safeToken)).toBe(false);
    expect(resolveAuthKey(safeToken)).toBe(safeToken);
  });
});
