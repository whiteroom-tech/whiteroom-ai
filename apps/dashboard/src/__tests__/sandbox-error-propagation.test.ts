import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/whiteroom/client", () => ({ PROXY_URL: "http://engine:3000" }));
vi.mock("@/lib/fleet-session", () => ({
  getFleetAuthCookie: async () => null,
  tokenFromUserFleets: async () => null,
}));

import { type SandboxResponse, toResponse } from "@/lib/sandbox/client";

describe("toResponse", () => {
  it("forwards engine status code", () => {
    const result: SandboxResponse = { data: { error: "Not found." }, status: 404 };
    const res = toResponse(result);
    expect(res.status).toBe(404);
  });

  it("forwards 429 with Retry-After header", () => {
    const result: SandboxResponse = {
      data: { error: "Rate limited.", retryAfter: 30 },
      status: 429,
      retryAfter: "30",
    };
    const res = toResponse(result);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
  });

  it("returns 200 with no extra headers on success", () => {
    const result: SandboxResponse = { data: { success: true }, status: 200 };
    const res = toResponse(result);
    expect(res.status).toBe(200);
    expect(res.headers.get("Retry-After")).toBeNull();
  });

  it("returns 502 when engine is unreachable", () => {
    const result: SandboxResponse = { data: { error: "Unavailable." }, status: 502 };
    const res = toResponse(result);
    expect(res.status).toBe(502);
  });

  it("returns 503 when service secret is missing", () => {
    const result: SandboxResponse = { data: { error: "Not configured." }, status: 503 };
    const res = toResponse(result);
    expect(res.status).toBe(503);
  });
});
