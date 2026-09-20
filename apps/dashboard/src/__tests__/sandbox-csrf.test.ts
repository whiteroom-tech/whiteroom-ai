import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const mockAuth = vi.fn();
vi.mock("@/auth", () => ({ auth: () => mockAuth() }));

const mockHeaders = vi.fn();
vi.mock("next/headers", () => ({ headers: () => mockHeaders() }));

import { requireSandboxUser, requireSandboxMutation } from "@/lib/sandbox/auth";

function fakeHeaders(origin: string | null, host: string | null) {
  mockHeaders.mockResolvedValue(new Map([["origin", origin], ["host", host]]));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1" } });
});

describe("requireSandboxUser", () => {
  it("returns ownerSubject for authenticated user", async () => {
    const result = await requireSandboxUser();
    expect(result).toEqual({ ownerSubject: "dashboard:u1" });
  });

  it("returns 401 for unauthenticated user", async () => {
    mockAuth.mockResolvedValue(null);
    const result = await requireSandboxUser();
    expect("error" in result).toBe(true);
  });
});

describe("requireSandboxMutation (CSRF)", () => {
  it("allows same-origin request", async () => {
    fakeHeaders("https://app.whiteroom.ai", "app.whiteroom.ai");
    const result = await requireSandboxMutation();
    expect(result).toEqual({ ownerSubject: "dashboard:u1" });
  });

  it("rejects cross-origin request", async () => {
    fakeHeaders("https://evil.com", "app.whiteroom.ai");
    const result = await requireSandboxMutation();
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.status).toBe(403);
    }
  });

  it("rejects missing origin header", async () => {
    fakeHeaders(null, "app.whiteroom.ai");
    const result = await requireSandboxMutation();
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.status).toBe(403);
    }
  });

  it("rejects invalid origin URL", async () => {
    fakeHeaders("not-a-url", "app.whiteroom.ai");
    const result = await requireSandboxMutation();
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.status).toBe(403);
    }
  });

  it("rejects unauthenticated user before checking origin", async () => {
    mockAuth.mockResolvedValue(null);
    fakeHeaders("https://app.whiteroom.ai", "app.whiteroom.ai");
    const result = await requireSandboxMutation();
    expect("error" in result).toBe(true);
  });
});
