import { describe, it, expect, vi } from "vitest";

vi.mock("next-auth/react", () => ({ useSession: () => ({ data: null }) }));
vi.mock("@whiteroom/ui", () => ({ FONT_DISPLAY: { className: "" }, FONT_MONO: { className: "" } }));
vi.mock("@/lib/analytics", () => ({ posthog: { capture: vi.fn() } }));
vi.mock("@/lib/whiteroom/client", () => ({ PROXY_URL: "https://proxy.whiteroom.ai" }));
vi.mock("@/lib/sandbox/api", () => ({}));

import { connectionRecipe } from "@/components/sandbox/TestRunFlow";
import { cloudRecipe, headersLiteral, withEndpoint } from "@/lib/sandbox/providers";

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

// Pinned byte for byte, so recipe changes are deliberate.
describe("connectionRecipe is unchanged for Anthropic and OpenAI", () => {
  it("Anthropic Python", () => {
    expect(connectionRecipe("anthropic", FLEET, AGENT, "Python")).toBe(`import anthropic

client = anthropic.Anthropic(
    base_url="https://proxy.whiteroom.ai",
    default_headers={
        "x-whiteroom-fleet": "sandbox-abc123",
        "x-whiteroom-agent": "test-agent"
    }
)
# Uses ANTHROPIC_API_KEY from your environment.
# Use this client for your agent's messages calls.`);
  });

  it("OpenAI JavaScript", () => {
    expect(connectionRecipe("openai", FLEET, AGENT, "JavaScript")).toBe(`import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: "https://proxy.whiteroom.ai/v1",
  defaultHeaders: {
    "x-whiteroom-fleet": "sandbox-abc123",
    "x-whiteroom-agent": "test-agent"
  }
});
// Uses OPENAI_API_KEY from your environment.
// Use this client for your agent's chat.completions calls.`);
  });
});

describe("cloudRecipe nests the headers inside the client call", () => {
  it("Bedrock Python", () => {
    expect(cloudRecipe("bedrock-mantle", "https://proxy.whiteroom.ai/sk-wr-abc", "test-agent", "Python")).toBe(`import os
import anthropic

client = anthropic.Anthropic(
    base_url="https://proxy.whiteroom.ai/sk-wr-abc",
    api_key=os.environ["AWS_BEARER_TOKEN_BEDROCK"],
    default_headers={
        "x-whiteroom-agent": "test-agent"
    }
)
# Use this client for your agent's messages calls,
# with a Bedrock model id as the model, like anthropic.claude-haiku-4-5.`);
  });
});

describe("headersLiteral and the cloud recipes", () => {
  const H = { "x-whiteroom-agent": "a" };

  it("nests the object one level for Python and JavaScript", () => {
    expect(headersLiteral(H, 4)).toBe('{\n        "x-whiteroom-agent": "a"\n    }');
    expect(headersLiteral(H, 2)).toBe('{\n    "x-whiteroom-agent": "a"\n  }');
  });

  it("every cloud recipe closes its headers under the argument", () => {
    for (const p of ["azure-openai", "foundry", "bedrock-mantle"] as const) {
      expect(cloudRecipe(p, "https://x.test/sk-wr-1", "a", "Python")).toContain('        "x-whiteroom-agent": "a"\n    }\n)');
      expect(cloudRecipe(p, "https://x.test/sk-wr-1", "a", "JavaScript")).toContain('    "x-whiteroom-agent": "a"\n  }\n});');
    }
  });
});

describe("start form endpoints", () => {
  it("keeps one value per cloud provider", () => {
    let e = withEndpoint({}, "azure-openai", "https://r.openai.azure.com");
    e = withEndpoint(e, "bedrock-mantle", "us-east-1");
    expect(e["azure-openai"]).toBe("https://r.openai.azure.com");
    expect(e["bedrock-mantle"]).toBe("us-east-1");
    expect(e.foundry).toBeUndefined();
  });
});
