import { describe, it, expect, vi } from "vitest";

vi.mock("next-auth/react", () => ({ useSession: () => ({ data: null }) }));
vi.mock("@/components/ThemeToggle", () => ({ ThemeToggle: () => null }));
vi.mock("@whiteroom/ui", () => ({ FONT_DISPLAY: { className: "" }, FONT_MONO: { className: "" } }));
vi.mock("@/lib/analytics", () => ({ posthog: { capture: vi.fn() } }));
vi.mock("@/lib/whiteroom/client", () => ({ PROXY_URL: "https://proxy.whiteroom.ai" }));
vi.mock("@/lib/sandbox/api", () => ({}));

import { connectionRecipe } from "@/components/sandbox/TestRunFlow";

const FLEET = "sandbox-abc123";
const AGENT = "test-agent";

describe("connectionRecipe", () => {
  describe("Anthropic", () => {
    it("Python: uses base_url and default_headers", () => {
      const code = connectionRecipe("anthropic", FLEET, AGENT, "Python");
      expect(code).toContain("base_url=");
      expect(code).toContain("default_headers=");
      expect(code).toContain("https://proxy.whiteroom.ai");
      expect(code).not.toContain("/v1");
      expect(code).toContain("x-whiteroom-fleet");
      expect(code).toContain("x-whiteroom-agent");
      expect(code).toContain(FLEET);
      expect(code).toContain(AGENT);
      expect(code).toContain("anthropic.Anthropic(");
    });

    it("JavaScript: uses baseURL and defaultHeaders", () => {
      const code = connectionRecipe("anthropic", FLEET, AGENT, "JavaScript");
      expect(code).toContain("baseURL:");
      expect(code).toContain("defaultHeaders:");
      expect(code).toContain("https://proxy.whiteroom.ai");
      expect(code).not.toContain("/v1");
      expect(code).toContain("x-whiteroom-fleet");
      expect(code).toContain(FLEET);
      expect(code).toContain("new Anthropic(");
    });
  });

  describe("OpenAI", () => {
    it("Python: appends /v1 to base URL", () => {
      const code = connectionRecipe("openai", FLEET, AGENT, "Python");
      expect(code).toContain("https://proxy.whiteroom.ai/v1");
      expect(code).toContain("base_url=");
      expect(code).toContain("default_headers=");
      expect(code).toContain("x-whiteroom-fleet");
      expect(code).toContain(FLEET);
      expect(code).toContain("OpenAI(");
    });

    it("JavaScript: appends /v1 to base URL", () => {
      const code = connectionRecipe("openai", FLEET, AGENT, "JavaScript");
      expect(code).toContain("https://proxy.whiteroom.ai/v1");
      expect(code).toContain("baseURL:");
      expect(code).toContain("defaultHeaders:");
      expect(code).toContain("x-whiteroom-fleet");
      expect(code).toContain(FLEET);
      expect(code).toContain("new OpenAI(");
    });
  });

  it("does not double /v1 if proxy URL has trailing slash", () => {
    const code = connectionRecipe("openai", FLEET, AGENT, "Python");
    expect(code).not.toContain("//v1");
  });

  it("includes both required headers in all variants", () => {
    for (const provider of ["anthropic", "openai"] as const) {
      for (const lang of ["Python", "JavaScript"] as const) {
        const code = connectionRecipe(provider, FLEET, AGENT, lang);
        expect(code).toContain("x-whiteroom-fleet");
        expect(code).toContain("x-whiteroom-agent");
        expect(code).toContain(FLEET);
        expect(code).toContain(AGENT);
      }
    }
  });
});
