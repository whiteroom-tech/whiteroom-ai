// Run: node --test .github/scripts/pr-health.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  BOT_LOGIN,
  MARKER,
  aggregateStats,
  applyVerification,
  checksSettled,
  ciScore,
  commentableRanges,
  computeHealth,
  diffSignals,
  dimensionScores,
  findOwnComment,
  findingKey,
  hygieneScore,
  inlineComments,
  ownInlineComments,
  parseFindingTag,
  parseReview,
  parseVerification,
  render,
  renderStats,
  sanitize,
  verdictFor,
} from "./pr-health-lib.mjs";

const baseReview = { summary: "Adds a thing.", findings: [] };
const finding = (o = {}) => ({
  severity: "minor",
  dimension: "correctness",
  file: "src/a.ts",
  line: 3,
  title: "t",
  detail: "d",
  suggestion: "",
  ...o,
  end_line: o.end_line ?? o.line ?? 3,
});
const json = (o) => JSON.stringify(o);
const cleanSignals = diffSignals([]);
const passed = (name) => ({ name, status: "completed", conclusion: "success" });
const confirmed = (o) => applyVerification(parseReview(json({ ...baseReview, findings: [finding(o)] })).findings, new Map([[0, { verdict: "confirmed", reason: "" }]]));
const renderArgs = (findings, signals = cleanSignals, extra = {}) => ({
  scores: computeHealth(findings.filter((f) => f.verification !== "refuted"), [], signals),
  signals,
  checks: [],
  summary: "s",
  findings,
  verified: true,
  sha: "abcdef0",
  ...extra,
});

// ---------- parseReview ----------

test("parseReview names the field when a finding is malformed", () => {
  assert.throws(() => parseReview(json({ ...baseReview, findings: [finding({ severity: "huge" })] })), /findings\[0\]\.severity/);
  assert.throws(() => parseReview(json({ ...baseReview, findings: [finding({ dimension: "style" })] })), /findings\[0\]\.dimension/);
  assert.throws(() => parseReview(json({ ...baseReview, findings: [finding({ title: 3 })] })), /findings\[0\]\.title/);
});

test("parseReview rejects empty, malformed and incomplete output clearly", () => {
  assert.throws(() => parseReview(""), /REVIEW_JSON is empty/);
  assert.throws(() => parseReview("{not json"), /not valid JSON/);
  assert.throws(() => parseReview(json({ ...baseReview, findings: undefined })), /review\.findings/);
  assert.throws(() => parseReview(json({ findings: [] })), /review\.summary/);
});

test("parseReview normalizes bad line numbers and ranges", () => {
  const r = parseReview(
    json({
      ...baseReview,
      findings: [
        finding({ line: -4, suggestion: "x" }),
        finding({ line: 2.5 }),
        finding({ line: 7, end_line: 5 }),
        finding({ line: 7, end_line: 9 }),
      ],
    }),
  );
  assert.deepEqual(r.findings.map((x) => [x.line, x.endLine]), [[0, 0], [0, 0], [7, 7], [7, 9]]);
  // A finding with no line can't carry a suggestion.
  assert.equal(r.findings[0].suggestion, "");
  assert.deepEqual(r.findings.map((x) => x.id), [0, 1, 2, 3]);
});

test("parseReview caps long text and drops oversized suggestions", () => {
  const r = parseReview(json({ summary: "s".repeat(5000), findings: [finding({ detail: "d".repeat(9000), suggestion: "x".repeat(6000) })] }));
  assert.ok(r.summary.length <= 1500);
  assert.ok(r.findings[0].detail.length <= 2000);
  assert.equal(r.findings[0].suggestion, "");
});

// ---------- Verification ----------

test("parseVerification returns null when the pass produced nothing usable", () => {
  assert.equal(parseVerification(""), null);
  assert.equal(parseVerification(undefined), null);
  assert.equal(parseVerification("{oops"), null);
  assert.equal(parseVerification(json({ nope: [] })), null);
});

test("applyVerification tags findings and treats skipped ones as uncertain", () => {
  const { findings } = parseReview(json({ ...baseReview, findings: [finding(), finding(), finding()] }));
  const v = parseVerification(
    json({ results: [{ id: 0, verdict: "confirmed", reason: "r" }, { id: 1, verdict: "refuted", reason: "guarded" }, { id: 9, verdict: "refuted", reason: "" }, { id: 2, verdict: "maybe", reason: "" }] }),
  );
  assert.deepEqual(applyVerification(findings, v).map((f) => f.verification), ["confirmed", "refuted", "uncertain"]);
  assert.deepEqual(applyVerification(findings, null).map((f) => f.verification), ["unverified", "unverified", "unverified"]);
});

// ---------- Scores from findings ----------

test("dimension scores come from surviving findings only", () => {
  const { findings } = parseReview(
    json({
      ...baseReview,
      findings: [
        finding({ severity: "major", dimension: "security" }),
        finding({ severity: "minor", dimension: "security" }),
        finding({ severity: "blocker", dimension: "correctness" }),
        finding({ severity: "blocker", dimension: "correctness" }),
        finding({ severity: "nit", dimension: "testing" }),
      ],
    }),
  );
  assert.deepEqual(dimensionScores(findings), { correctness: 0, security: 6, maintainability: 10, testing: 10 });
  assert.deepEqual(dimensionScores([]), { correctness: 10, security: 10, maintainability: 10, testing: 10 });
});

test("verdict follows the worst surviving finding", () => {
  assert.equal(verdictFor([]), "ready");
  assert.equal(verdictFor([{ severity: "minor" }]), "ready");
  assert.equal(verdictFor([{ severity: "minor" }, { severity: "major" }]), "needs_changes");
  assert.equal(verdictFor([{ severity: "blocker" }]), "risky");
});

test("a refuted blocker costs nothing", () => {
  const { findings } = parseReview(json({ ...baseReview, findings: [finding({ severity: "blocker" })] }));
  const tagged = applyVerification(findings, new Map([[0, { verdict: "refuted", reason: "" }]]));
  const kept = tagged.filter((f) => f.verification !== "refuted");
  assert.equal(computeHealth(kept, [passed("a")], cleanSignals).health, 100);
  assert.equal(computeHealth(tagged, [passed("a")], cleanSignals).health, 59);
});

// ---------- CI and health ----------

test("ciScore counts checks still running as not passed", () => {
  const checks = [passed("a"), { name: "b", status: "in_progress", conclusion: null }];
  assert.equal(ciScore(checks), 50);
});

test("ciScore ignores skipped checks and returns null when nothing counts", () => {
  assert.equal(ciScore([]), null);
  assert.equal(ciScore([{ name: "a", status: "completed", conclusion: "skipped" }]), null);
  assert.equal(ciScore([passed("a"), { name: "b", status: "completed", conclusion: "skipped" }]), 100);
});

test("a pending check caps health like a failing one", () => {
  const pending = [passed("a"), { name: "b", status: "queued", conclusion: null }];
  assert.equal(computeHealth([], [passed("a")], cleanSignals).health, 100);
  assert.ok(computeHealth([], pending, cleanSignals).health <= 69);
});

test("health weights shift to the review when there are no checks", () => {
  const { findings } = parseReview(json({ ...baseReview, findings: [finding({ severity: "major" })] }));
  const { health, ci, reviewScore, hygiene } = computeHealth(findings, [], cleanSignals);
  assert.equal(ci, null);
  assert.equal(health, Math.round(hygiene * 0.2 + reviewScore * 0.8));
});

// ---------- Inline comments ----------

const file = (patch, filename = "src/a.ts") => ({ filename, additions: 1, deletions: 0, changes: 1, status: "modified", patch });

test("commentableRanges reads new-file ranges from hunk headers", () => {
  assert.deepEqual(commentableRanges("@@ -1,3 +1,4 @@ fn\n x\n+y\n@@ -20 +21 @@\n+z\n@@ -30,2 +32,0 @@\n-a\n-b"), [[1, 4], [21, 21]]);
  assert.deepEqual(commentableRanges(undefined), []);
});

test("inlineComments posts only confirmed, non-nit findings inside the diff", () => {
  const files = [file("@@ -1,3 +1,5 @@\n a\n+b")];
  const { findings } = parseReview(
    json({
      ...baseReview,
      findings: [
        finding({ line: 2 }),
        finding({ line: 2, severity: "nit", title: "nit" }),
        finding({ line: 40, title: "off the diff" }),
        finding({ line: 2, file: "src/other.ts", title: "other file" }),
        finding({ line: 0, title: "general" }),
        finding({ line: 3, title: "unsure" }),
      ],
    }),
  );
  const v = new Map(findings.map((f) => [f.id, { verdict: f.title === "unsure" ? "uncertain" : "confirmed", reason: "" }]));
  const out = inlineComments(applyVerification(findings, v), files);
  assert.equal(out.length, 1);
  assert.deepEqual({ path: out[0].path, line: out[0].line, side: out[0].side }, { path: "src/a.ts", line: 2, side: "RIGHT" });
  assert.equal(out[0].start_line, undefined);
});

test("inlineComments anchors a range and keeps its suggestion only inside one hunk", () => {
  const files = [file("@@ -1,3 +1,5 @@\n a\n+b")];
  const [inside] = inlineComments(confirmed({ line: 2, end_line: 4, suggestion: "fixed()" }), files);
  assert.equal(inside.start_line, 2);
  assert.equal(inside.line, 4);
  assert.match(inside.body, /```suggestion\nfixed\(\)\n```/);
  const [spill] = inlineComments(confirmed({ line: 4, end_line: 9, suggestion: "fixed()" }), files);
  assert.equal(spill.line, 4);
  assert.equal(spill.start_line, undefined);
  assert.ok(!spill.body.includes("suggestion"));
});

test("inlineComments skips findings already posted", () => {
  const files = [file("@@ -1,3 +1,5 @@\n a")];
  const f = confirmed({ line: 2, title: "Same   Title" });
  assert.equal(inlineComments(f, files, new Set([findingKey({ file: "src/a.ts", title: "same title" })])).length, 0);
  assert.equal(inlineComments(f, files).length, 1);
  assert.equal(inlineComments([...f, ...f], files).length, 1);
});

test("a suggestion can't close its fence early", () => {
  const [c] = inlineComments(confirmed({ line: 1, suggestion: "a\n```\n@bob <img>" }), [file("@@ -1 +1 @@\n+a")]);
  assert.match(c.body, /````suggestion\na\n```\n@bob <img>\n````/);
});

test("inline comments carry metadata that round-trips and resists forgery", () => {
  const [c] = inlineComments(confirmed({ line: 1, title: "x --> y", severity: "major", dimension: "security" }), [file("@@ -1 +1 @@\n+a")]);
  assert.deepEqual(parseFindingTag(c.body), { k: c.key, s: "major", d: "security", t: "x --> y", f: "src/a.ts" });
  assert.equal(parseFindingTag("no tag here"), null);
  const mine = { user: { login: BOT_LOGIN }, body: c.body };
  const copied = { user: { login: "someone" }, body: c.body };
  assert.equal(ownInlineComments([mine, copied]).length, 1);
});

// ---------- Rendering with verification ----------

test("render lists refuted findings apart and drops them from the score", () => {
  const { findings } = parseReview(json({ ...baseReview, findings: [finding({ title: "real" }), finding({ severity: "blocker", title: "bogus" })] }));
  const tagged = applyVerification(findings, new Map([[0, { verdict: "confirmed", reason: "" }], [1, { verdict: "refuted", reason: "guarded in caller" }]]));
  const out = render(renderArgs(tagged, cleanSignals, { inlinePosted: 1 }));
  assert.match(out, /### Findings \(1\)/);
  assert.match(out, /real\*\* · `src\/a\.ts:3` · ✔ verified/);
  assert.match(out, /Dropped by verification \(1\)/);
  assert.match(out, /bogus · `src\/a\.ts`: guarded in caller/);
  assert.match(out, /1 verified finding\(s\) posted as line comments/);
  assert.match(out, /✅ Ready/);
});

test("render says so when the verification pass didn't run", () => {
  const { findings } = parseReview(json({ ...baseReview, findings: [finding()] }));
  const out = render(renderArgs(applyVerification(findings, null), cleanSignals, { verified: false }));
  assert.match(out, /verification pass didn't run/);
});

// ---------- Resolution stats ----------

test("aggregateStats counts outdated threads as fixed and resolved ones as dismissed", () => {
  const t = (s, d, isOutdated, isResolved, up = 0, down = 0) => ({ meta: { s, d }, isOutdated, isResolved, up, down });
  const stats = aggregateStats([
    t("major", "security", true, true, 1),
    t("major", "security", false, true, 0, 1),
    t("minor", "correctness", false, false),
    t("minor", "correctness", true, false),
  ]);
  assert.deepEqual(stats.total, { posted: 4, fixed: 2, dismissed: 1, unaddressed: 1, up: 1, down: 1 });
  assert.deepEqual(stats.bySeverity.major, { posted: 2, fixed: 1, dismissed: 1, unaddressed: 0, up: 1, down: 1 });
  assert.equal(stats.byDimension.correctness.fixed, 1);
  const out = renderStats(stats, { prs: 3, days: 30 });
  assert.match(out, /\| \*\*All\*\* \| 4 \| 2 \| 1 \| 1 \| \*\*50%\*\* \| 1 \/ 1 \|/);
  const empty = renderStats(aggregateStats([]), { prs: 5, days: 7 });
  assert.match(empty, /0 line comments across 5 merged PRs/);
  assert.ok(!empty.includes("|"));
});

// ---------- Waiting on checks ----------

test("checksSettled waits out the grace period even when every visible check is done", () => {
  const runs = [passed("PR health tests")];
  assert.equal(checksSettled({ runs, now: 60_000, startedAt: 0, graceMs: 180_000 }), false);
  assert.equal(checksSettled({ runs, now: 180_000, startedAt: 0, graceMs: 180_000 }), true);
});

test("checksSettled keeps waiting while any check is running", () => {
  const runs = [passed("a"), { name: "b", status: "in_progress", conclusion: null }];
  assert.equal(checksSettled({ runs, now: 999_999, startedAt: 0, graceMs: 0 }), false);
});

test("checksSettled settles on no checks once the grace period is over", () => {
  assert.equal(checksSettled({ runs: [], now: 10, startedAt: 0, graceMs: 180_000 }), false);
  assert.equal(checksSettled({ runs: [], now: 180_000, startedAt: 0, graceMs: 180_000 }), true);
});

// ---------- Diff signals ----------

test("hygieneScore penalizes size, missing tests and added smells", () => {
  assert.equal(hygieneScore(cleanSignals), 100);
  assert.equal(hygieneScore({ ...cleanSignals, additions: 700 }), 88);
  assert.equal(hygieneScore({ ...cleanSignals, srcFilesChanged: 3 }), 80);
  assert.equal(hygieneScore({ ...cleanSignals, addedTsIgnores: 10 }), 85);
});

test("diffSignals counts added smells, skipping tests for console.log and any", () => {
  const s = diffSignals([
    { filename: "src/a.ts", additions: 3, deletions: 0, changes: 3, status: "modified", patch: "@@\n+console.log(x)\n+const y: any = 1\n+// TODO later" },
    { filename: "src/a.test.ts", additions: 1, deletions: 0, changes: 1, status: "added", patch: "@@\n+console.log(t)" },
    { filename: "package-lock.json", additions: 999, deletions: 0, changes: 999, status: "modified", patch: "@@\n+x" },
  ]);
  assert.equal(s.addedConsoleLogs, 1);
  assert.equal(s.addedAnyTypes, 1);
  assert.equal(s.addedTodos, 1);
  assert.equal(s.additions, 4);
  assert.equal(s.testFilesChanged, 1);
});

test("diffSignals reports files GitHub sent without a patch", () => {
  const s = diffSignals([
    { filename: "big.ts", additions: 5000, deletions: 0, changes: 5000, status: "modified" },
    { filename: "gone.ts", additions: 0, deletions: 10, changes: 10, status: "removed" },
    { filename: "logo.png", additions: 0, deletions: 0, changes: 0, status: "added" },
  ]);
  assert.deepEqual(s.filesWithoutPatch, ["big.ts"]);
  const out = render(renderArgs([], s));
  assert.match(out, /no patch for 1 large or binary file/);
});

// ---------- Sanitizing and rendering ----------

test("sanitize neutralizes mentions, HTML, links and emphasis but keeps code spans", () => {
  const out = sanitize("ping @alice <img src=x> [click](https://evil.test/a_b) **bold** `a<b> @c`");
  assert.ok(!out.includes("@alice"));
  assert.ok(out.includes("@​alice"));
  assert.ok(!out.includes("<img"));
  assert.ok(out.includes("\\[click\\]"));
  assert.ok(out.includes("`https://evil.test/a_b)`"));
  assert.ok(out.includes("\\*\\*bold\\*\\*"));
  assert.ok(out.includes("`a<b> @c`"));
});

test("sanitize defuses headings, list markers, issue refs, www links and lone backticks", () => {
  assert.ok(sanitize("# Heading").startsWith("\\#"));
  assert.ok(sanitize("- item").startsWith("\\-"));
  assert.ok(sanitize("1. item").startsWith("1\\."));
  assert.ok(sanitize("2) item").startsWith("2\\)"));
  assert.ok(!/#\d/.test(sanitize("fixes #123 and org/repo#9")));
  assert.ok(sanitize("see www.evil.test now").includes("`www.evil.test`"));
  // An unpaired backtick is escaped rather than opening a code span.
  assert.equal(sanitize("a ` b"), "a \\` b");
  // A # that isn't an issue reference is left alone.
  assert.equal(sanitize("C# code"), "C# code");
});

test("sanitize keeps model output from forging our marker or breaking lines", () => {
  const out = sanitize(`${MARKER}\n\n## Fake heading`);
  assert.ok(!out.includes(MARKER));
  assert.ok(!out.includes("\n"));
});

test("render keeps backticks in file names from breaking the location span", () => {
  const out = render(renderArgs(confirmed({ file: "we`ird.ts", title: "@bob look" })));
  assert.ok(out.includes("`weird.ts:3`"));
  assert.ok(!out.includes("@bob"));
  assert.ok(out.startsWith(MARKER));
});

// ---------- Sticky comment ----------

test("findOwnComment ignores marker copies from other authors", () => {
  const quoted = { id: 1, user: { login: "someone" }, body: `> ${MARKER}` };
  const ours = { id: 2, user: { login: BOT_LOGIN }, body: `${MARKER}\nscore` };
  assert.equal(findOwnComment([quoted, ours])?.id, 2);
  assert.equal(findOwnComment([quoted]), undefined);
});

test("findOwnComment can match a different bot login", () => {
  const app = { id: 3, user: { login: "whiteroom-bot[bot]" }, body: MARKER };
  assert.equal(findOwnComment([app]), undefined);
  assert.equal(findOwnComment([app], "whiteroom-bot[bot]")?.id, 3);
});

// ---------- Workflow wiring ----------

test("schemas have no single quotes, since the workflow wraps them in '...'", () => {
  for (const f of ["./pr-health-schema.json", "./pr-health-verify-schema.json"]) {
    const schema = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.ok(!schema.includes("'"), f);
    JSON.parse(schema);
  }
});
