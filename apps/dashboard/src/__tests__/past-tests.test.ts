import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { isEmptyTest, PastTestDetail, PastTests, pastResult } from "@/components/sandbox/PastTests";

describe("Past tests", () => {
  it("hides a test with nothing tested, no tasks and no report", () => {
    const html = renderToStaticMarkup(createElement(PastTests, { preview: [
      { sandboxId: "s1", destroyedAt: "2026-10-12T10:00:00Z", overall: "empty", totalTasks: 0, isTrial: false },
    ] }));
    expect(html).toContain("No tests yet.");
    expect(html).not.toContain("Not tested");
    expect(isEmptyTest({ overall: "empty", totalTasks: 0, destroyedAt: "2026-10-12T10:00:00Z" })).toBe(true);
    expect(isEmptyTest({ overall: "empty", totalTasks: 0, destroyedAt: "2026-10-12T10:00:00Z", hasReport: true })).toBe(false);
  });

  it("treats a legacy test with nothing checked as empty, and hides it", () => {
    // Before Oct 12 the engine stored it as partial; its task count is calls that came back OK.
    const before = "2026-10-12T10:50:00Z";
    const after = "2026-10-13T09:00:00Z";
    expect(pastResult({ overall: "partial", totalTasks: 0, destroyedAt: before })).toBe("empty");
    expect(pastResult({ overall: "partial", totalTasks: 2, destroyedAt: before })).toBe("partial");
    expect(pastResult({ overall: "pass", totalTasks: 0, destroyedAt: before })).toBe("pass");
    // Records made after the engine began storing "empty" are shown as stored.
    expect(pastResult({ overall: "partial", totalTasks: 0, destroyedAt: after })).toBe("partial");
    const html = renderToStaticMarkup(createElement(PastTests, { preview: [
      { sandboxId: "s1", destroyedAt: "2026-10-01T10:00:00Z", overall: "partial", totalTasks: 0, isTrial: false },
      { sandboxId: "s2", destroyedAt: "2026-10-01T11:00:00Z", overall: "partial", totalTasks: 2, isTrial: false },
    ] }));
    expect(html).toContain('wr-panel__count">1<');
    expect(html).toContain("Didn&#x27;t pass");
    expect(html).not.toContain("Some checks passed");
  });

  it("uses Passed / Didn't pass for connection tests, like practice tests", () => {
    const html = renderToStaticMarkup(createElement(PastTests, { preview: [
      { sandboxId: "a", destroyedAt: "2026-10-14T10:00:00Z", overall: "pass", totalTasks: 3, isTrial: false },
      { sandboxId: "b", destroyedAt: "2026-10-14T09:00:00Z", overall: "partial", totalTasks: 2, isTrial: false },
      { sandboxId: "c", destroyedAt: "2026-10-14T08:00:00Z", overall: "fail", totalTasks: 1, isTrial: false },
    ] }));
    expect(html.match(/>Passed</g)).toHaveLength(1);
    expect(html.match(/>Didn&#x27;t pass</g)).toHaveLength(2);
    for (const old of ["All checks passed", "Some checks passed", "Checks didn’t pass"]) expect(html).not.toContain(old);
  });

  it("gives Didn't pass the warn tone and still lists an empty test that has tasks or a report as Not checked", () => {
    const html = renderToStaticMarkup(createElement(PastTests, { preview: [
      { sandboxId: "a", destroyedAt: "2026-10-14T10:00:00Z", overall: "pass", totalTasks: 3, isTrial: false },
      { sandboxId: "b", destroyedAt: "2026-10-14T09:00:00Z", overall: "fail", totalTasks: 1, isTrial: false },
      { sandboxId: "c", destroyedAt: "2026-10-14T08:00:00Z", overall: "empty", totalTasks: 0, isTrial: false, hasReport: true },
      { sandboxId: "d", destroyedAt: "2026-10-14T07:00:00Z", overall: "empty", totalTasks: 2, isTrial: false },
    ] }));
    expect(html).toContain('wr-tag--brand">Passed<');
    expect(html).toContain('wr-tag--warn">Didn&#x27;t pass<');
    expect(html.match(/wr-tag--muted">Not checked</g)).toHaveLength(2);
    expect(html).toContain('wr-panel__count">4<');
  });

  it("makes rows openable from the keyboard", () => {
    const html = renderToStaticMarkup(createElement(PastTests, { preview: [
      { sandboxId: "s1", destroyedAt: "2026-10-12T10:00:00Z", overall: "pass", totalTasks: 3, isTrial: false },
    ] }));
    expect(html).toContain('role="grid"');
    expect(html).toMatch(/role="row" tabindex="0"/);
  });

  it("says when there are no tests yet, and links the sample report (the demo, §7)", () => {
    const html = renderToStaticMarkup(createElement(PastTests, { preview: [] }));
    expect(html).toContain("No tests yet.");
    expect(html).toContain('href="/sandbox/practice?demo=1">See a sample report</a> to see what you’ll get.');
  });

  it("shows only what history keeps, and says the rest isn't kept", () => {
    const html = renderToStaticMarkup(createElement(PastTestDetail, { test: { sandboxId: "abc-123", destroyedAt: "2026-10-12T10:00:00Z", overall: "pass", totalTasks: 4, isTrial: true }, onClose: () => {} }));
    for (const text of [">Passed<", ">4 <", "Demo", "abc-123", "aren’t kept after a test ends"]) expect(html).toContain(text);
    expect(html).not.toMatch(/Your agent connects|memory fills up/);
  });
});
