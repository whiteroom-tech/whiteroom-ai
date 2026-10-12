import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PastTests } from "@/components/sandbox/PastTests";

describe("Past tests", () => {
  it("labels a test with nothing tested 'Not tested'", () => {
    const html = renderToStaticMarkup(createElement(PastTests, { preview: [
      { sandboxId: "s1", destroyedAt: "2026-10-12T10:00:00Z", overall: "empty", totalTasks: 0, isTrial: false },
    ] }));
    expect(html).toContain("Not tested");
    expect(html).not.toContain("Some checks passed");
  });
});
