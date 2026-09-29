// Run: node --test .github/scripts/pr-health.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  BOT_LOGIN,
  MARKER,
  checksSettled,
  ciScore,
  computeHealth,
  diffSignals,
  findOwnComment,
  hygieneScore,
  parseReview,
  render,
  sanitize,
} from "./pr-health-lib.mjs";

const baseReview = {
  summary: "Adds a thing.",
  verdict: "ready",
  scores: { correctness: 9, security: 10, maintainability: 8, testing: 7 },
  findings: [],
};
const json = (o) => JSON.stringify(o);
const cleanSignals = diffSignals([]);
const passed = (name) => ({ name, status: "completed", conclusion: "success" });

// ---------- parseReview ----------

test("parseReview rounds and clamps scores", () => {
  const r = parseReview(json({ ...baseReview, scores: { correctness: 12, security: -3, maintainability: 7.6, testing: 0 } }));
  assert.deepEqual(r.scores, { correctness: 10, security: 0, maintainability: 8, testing: 0 });
});

test("parseReview names the field when a score is missing or not a number", () => {
  assert.throws(
    () => parseReview(json({ ...baseReview, scores: { ...baseReview.scores, testing: undefined } })),
    /review\.scores\.testing/,
  );
  assert.throws(
    () => parseReview(json({ ...baseReview, scores: { ...baseReview.scores, security: "9" } })),
    /review\.scores\.security/,
  );
});

test("parseReview rejects empty, malformed and incomplete output clearly", () => {
  assert.throws(() => parseReview(""), /REVIEW_JSON is empty/);
  assert.throws(() => parseReview("{not json"), /not valid JSON/);
  assert.throws(() => parseReview(json({ ...baseReview, findings: undefined })), /review\.findings/);
  assert.throws(() => parseReview(json({ ...baseReview, verdict: "lgtm" })), /review\.verdict/);
  assert.throws(
    () => parseReview(json({ ...baseReview, findings: [{ severity: "huge", file: "a", line: 1, title: "t", detail: "d" }] })),
    /findings\[0\]\.severity/,
  );
});

test("parseReview normalizes a bad line number to 0", () => {
  const f = { severity: "minor", file: "a.ts", title: "t", detail: "d" };
  const r = parseReview(json({ ...baseReview, findings: [{ ...f, line: -4 }, { ...f, line: 2.5 }, { ...f, line: 7 }] }));
  assert.deepEqual(r.findings.map((x) => x.line), [0, 0, 7]);
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
  const review = parseReview(json({ ...baseReview, scores: { correctness: 10, security: 10, maintainability: 10, testing: 10 } }));
  const pending = [passed("a"), { name: "b", status: "queued", conclusion: null }];
  assert.equal(computeHealth(review, [passed("a")], cleanSignals).health, 100);
  assert.ok(computeHealth(review, pending, cleanSignals).health <= 69);
});

test("a blocker caps health at 59", () => {
  const review = parseReview(
    json({
      ...baseReview,
      scores: { correctness: 10, security: 10, maintainability: 10, testing: 10 },
      findings: [{ severity: "blocker", file: "a.ts", line: 1, title: "t", detail: "d" }],
    }),
  );
  assert.equal(computeHealth(review, [passed("a")], cleanSignals).health, 59);
});

test("health weights shift to the review when there are no checks", () => {
  const review = parseReview(json(baseReview));
  const { health, ci, reviewScore, hygiene } = computeHealth(review, [], cleanSignals);
  assert.equal(ci, null);
  assert.equal(health, Math.round(hygiene * 0.2 + reviewScore * 0.8));
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
  const out = render({ scores: computeHealth(parseReview(json(baseReview)), [], s), signals: s, checks: [], review: parseReview(json(baseReview)), sha: "abcdef0" });
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
  const review = parseReview(
    json({ ...baseReview, findings: [{ severity: "minor", file: "we`ird.ts", line: 3, title: "@bob look", detail: "x" }] }),
  );
  const out = render({ scores: computeHealth(review, [], cleanSignals), signals: cleanSignals, checks: [], review, sha: "abcdef0" });
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

test("schema has no single quotes, since the workflow wraps it in '...'", () => {
  const schema = readFileSync(new URL("./pr-health-schema.json", import.meta.url), "utf8");
  assert.ok(!schema.includes("'"));
  JSON.parse(schema);
});
