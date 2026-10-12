import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PastTestDetail, PastTests, pastResult } from "@/components/sandbox/PastTests";

describe("Past tests", () => {
  it("labels a test with nothing tested 'Not tested'", () => {
    const html = renderToStaticMarkup(createElement(PastTests, { preview: [
      { sandboxId: "s1", destroyedAt: "2026-10-12T10:00:00Z", overall: "empty", totalTasks: 0, isTrial: false },
    ] }));
    expect(html).toContain("Not tested");
    expect(html).not.toContain("Some checks passed");
  });

  it("shows a legacy test with nothing checked as 'Not tested'", () => {
    // Before Oct 12 the engine stored it as partial; its task count is calls that came back OK.
    expect(pastResult({ overall: "partial", totalTasks: 0 })).toBe("empty");
    expect(pastResult({ overall: "partial", totalTasks: 2 })).toBe("partial");
    expect(pastResult({ overall: "pass", totalTasks: 0 })).toBe("pass");
    const html = renderToStaticMarkup(createElement(PastTests, { preview: [
      { sandboxId: "s1", destroyedAt: "2026-10-01T10:00:00Z", overall: "partial", totalTasks: 0, isTrial: false },
    ] }));
    expect(html).toContain("Not tested");
    expect(html).not.toContain("Some checks passed");
  });

  it("makes rows openable from the keyboard", () => {
    const html = renderToStaticMarkup(createElement(PastTests, { preview: [
      { sandboxId: "s1", destroyedAt: "2026-10-12T10:00:00Z", overall: "pass", totalTasks: 3, isTrial: false },
    ] }));
    expect(html).toContain('role="grid"');
    expect(html).toMatch(/role="row" tabindex="0"/);
  });

  it("says when there are no tests yet", () => {
    const html = renderToStaticMarkup(createElement(PastTests, { preview: [], onDemo: () => {} }));
    expect(html).toContain("No tests yet.");
    expect(html).toContain("Run the demo</button> to see what you’ll get.");
  });

  it("shows only what history keeps, and says the rest isn't kept", () => {
    const html = renderToStaticMarkup(createElement(PastTestDetail, { test: { sandboxId: "abc-123", destroyedAt: "2026-10-12T10:00:00Z", overall: "pass", totalTasks: 4, isTrial: true }, onClose: () => {} }));
    for (const text of ["All checks passed", ">4 <", "Demo", "abc-123", "aren’t kept after a test ends"]) expect(html).toContain(text);
    expect(html).not.toMatch(/Your agent connects|memory fills up/);
  });
});
