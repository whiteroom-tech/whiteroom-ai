// Pure pieces of the PR health bot: review parsing, verification, scoring,
// inline comments and rendering. pr-health.mjs does the GitHub I/O;
// pr-health.test.mjs covers this file.

import { createHash } from "node:crypto";

export const MARKER = "<!-- whiteroom-pr-health -->";
// Each inline comment carries this, followed by base64 JSON describing the
// finding, so later runs and the stats job can recognize it.
const FINDING_TAG = "whiteroom-pr-health-finding";
// Comments posted with the workflow's github.token are authored by this bot.
// Set PR_HEALTH_BOT_LOGIN if the workflow ever posts with a PAT or app token,
// or the old comment won't be found and each run will post a new one.
export const BOT_LOGIN = process.env.PR_HEALTH_BOT_LOGIN || "github-actions[bot]";

const SEVERITIES = ["blocker", "major", "minor", "nit"];
const DIMENSIONS = ["correctness", "security", "maintainability", "testing"];
const VERIFICATIONS = ["confirmed", "refuted", "uncertain"];

// Points each surviving finding takes off its dimension's 10.
export const PENALTY = { blocker: 6, major: 3, minor: 1, nit: 0 };
// Only verified findings at these severities are posted on the diff lines.
const INLINE_SEVERITIES = ["blocker", "major", "minor"];

// Keep one runaway field from pushing a comment past GitHub's 65k limit.
const LIMITS = { summary: 1500, title: 200, detail: 2000, reason: 500, suggestion: 5000 };

// GitHub's pulls/files endpoint stops listing files here.
export const FILES_API_CAP = 3000;

function cap(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ---------- Review ----------

// Validate the structured output from the Claude review step. Throws with the
// offending field rather than letting NaN or undefined reach the score.
export function parseReview(raw) {
  if (!raw) throw new Error("REVIEW_JSON is empty; the Claude review step produced no structured output");
  let r;
  try {
    r = JSON.parse(raw);
  } catch (e) {
    throw new Error(`REVIEW_JSON is not valid JSON: ${e.message}`);
  }
  if (!r || typeof r !== "object") throw new Error("review: expected an object");
  if (typeof r.summary !== "string") throw new Error("review.summary: expected a string");
  if (!Array.isArray(r.findings)) throw new Error("review.findings: expected an array");

  const findings = r.findings.map((f, i) => {
    const at = `review.findings[${i}]`;
    if (!f || typeof f !== "object") throw new Error(`${at}: expected an object`);
    for (const k of ["file", "title", "detail"]) {
      if (typeof f[k] !== "string") throw new Error(`${at}.${k}: expected a string`);
    }
    if (!SEVERITIES.includes(f.severity)) throw new Error(`${at}.severity: expected one of ${SEVERITIES.join(", ")}`);
    if (!DIMENSIONS.includes(f.dimension)) throw new Error(`${at}.dimension: expected one of ${DIMENSIONS.join(", ")}`);
    const line = Number.isInteger(f.line) && f.line > 0 ? f.line : 0;
    const endLine = line && Number.isInteger(f.end_line) && f.end_line >= line ? f.end_line : line;
    // A suggestion replaces whole lines, so a cut-off one would be broken code.
    const suggestion = typeof f.suggestion === "string" && f.suggestion.length <= LIMITS.suggestion ? f.suggestion : "";
    return {
      id: i,
      severity: f.severity,
      dimension: f.dimension,
      file: f.file,
      line,
      endLine,
      title: cap(f.title, LIMITS.title),
      detail: cap(f.detail, LIMITS.detail),
      suggestion: line ? suggestion : "",
    };
  });

  return { summary: cap(r.summary, LIMITS.summary), findings };
}

// ---------- Verification ----------

// Validate the second pass's verdicts. Returns null when the pass didn't run
// or produced nothing, so callers can tell "unverified" from "refuted".
export function parseVerification(raw) {
  if (!raw) return null;
  let v;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || !Array.isArray(v.results)) return null;
  const out = new Map();
  for (const r of v.results) {
    if (!r || !Number.isInteger(r.id) || !VERIFICATIONS.includes(r.verdict)) continue;
    out.set(r.id, { verdict: r.verdict, reason: cap(typeof r.reason === "string" ? r.reason : "", LIMITS.reason) });
  }
  return out;
}

// Tag each finding with its verdict. With no verification at all, findings
// are "unverified"; a finding the verifier skipped counts as "uncertain".
export function applyVerification(findings, verification) {
  return findings.map((f) => {
    if (!verification) return { ...f, verification: "unverified", reason: "" };
    const v = verification.get(f.id);
    return { ...f, verification: v?.verdict ?? "uncertain", reason: v?.reason ?? "" };
  });
}

// ---------- Deterministic signals ----------

const TEST_RE = /(__tests__|\.test\.|\.spec\.|\/tests?\/)/;
const SRC_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const LOCK_RE = /(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/;

export function diffSignals(files) {
  const code = files.filter((f) => !LOCK_RE.test(f.filename));
  const additions = code.reduce((n, f) => n + f.additions, 0);
  const deletions = code.reduce((n, f) => n + f.deletions, 0);
  const srcChanged = code.filter((f) => SRC_RE.test(f.filename) && !TEST_RE.test(f.filename));
  const testsChanged = code.filter((f) => TEST_RE.test(f.filename));

  // GitHub omits `patch` for large or binary files, so the line counts below
  // only cover files it returned a patch for. Deleted files add no lines.
  const withoutPatch = code.filter((f) => f.patch == null && f.status !== "removed" && f.changes > 0);

  const added = code.flatMap((f) =>
    (f.patch || "")
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
      .map((l) => ({ file: f.filename, line: l.slice(1) })),
  );
  const count = (re, onlySrc = true) =>
    added.filter((a) => re.test(a.line) && (!onlySrc || !TEST_RE.test(a.file))).length;

  return {
    files: files.length,
    fileListTruncated: files.length >= FILES_API_CAP,
    filesWithoutPatch: withoutPatch.map((f) => f.filename),
    additions,
    deletions,
    srcFilesChanged: srcChanged.length,
    testFilesChanged: testsChanged.length,
    depsChanged: files.some((f) => /(^|\/)package\.json$/.test(f.filename)),
    migrationsChanged: files.some((f) => /migrations?\//.test(f.filename)),
    addedTodos: count(/\b(TODO|FIXME|XXX|HACK)\b/, false),
    addedConsoleLogs: count(/\bconsole\.(log|debug)\(/),
    addedAnyTypes: count(/:\s*any\b|as any\b/),
    addedTsIgnores: count(/@ts-(ignore|nocheck|expect-error)|eslint-disable/, false),
  };
}

// ---------- Waiting on checks ----------

// Whether to stop waiting on the other checks. All of them must be finished,
// and the job must have been running for at least graceMs: a fast check can
// finish before slower workflows have registered theirs.
export function checksSettled({ runs, now, startedAt, graceMs }) {
  return now - startedAt >= graceMs && runs.every((r) => r.status === "completed");
}

// ---------- Scoring ----------

// Pass rate of the other checks, 0-100. A check still running when we stop
// waiting counts against the score: we can't call it a pass.
export function ciScore(checks) {
  const counted = checks.filter((c) => !(c.status === "completed" && c.conclusion === "skipped"));
  if (counted.length === 0) return null;
  const good = counted.filter((c) => c.status === "completed" && ["success", "neutral"].includes(c.conclusion)).length;
  return Math.round((good / counted.length) * 100);
}

export function hygieneScore(s) {
  let score = 100;
  const lines = s.additions + s.deletions;
  if (lines > 1500) score -= 25;
  else if (lines > 600) score -= 12;
  if (s.srcFilesChanged >= 3 && s.testFilesChanged === 0) score -= 20;
  score -= Math.min(15, s.addedConsoleLogs * 3);
  score -= Math.min(15, s.addedAnyTypes * 3);
  score -= Math.min(15, s.addedTsIgnores * 5);
  score -= Math.min(10, s.addedTodos * 2);
  return Math.max(0, score);
}

// Dimension scores follow from the findings that survived verification, so
// every point off traces to a finding and a refuted one costs nothing.
export function dimensionScores(findings) {
  const scores = Object.fromEntries(DIMENSIONS.map((k) => [k, 10]));
  for (const f of findings) scores[f.dimension] -= PENALTY[f.severity];
  for (const k of DIMENSIONS) scores[k] = Math.max(0, scores[k]);
  return scores;
}

export function verdictFor(findings) {
  if (findings.some((f) => f.severity === "blocker")) return "risky";
  if (findings.some((f) => f.severity === "major")) return "needs_changes";
  return "ready";
}

// `findings` are the ones that survived verification.
export function computeHealth(findings, checks, signals) {
  const s = dimensionScores(findings);
  const reviewScore = Math.round(((s.correctness * 2 + s.security * 2 + s.maintainability + s.testing) / 60) * 100);
  const ci = ciScore(checks);
  const hygiene = hygieneScore(signals);
  let health = Math.round(
    ci == null ? hygiene * 0.2 + reviewScore * 0.8 : ci * 0.3 + hygiene * 0.15 + reviewScore * 0.55,
  );
  // A blocker or a red or unfinished check shouldn't be averaged away by good
  // scores elsewhere.
  if (findings.some((f) => f.severity === "blocker")) health = Math.min(health, 59);
  if (ci != null && ci < 100) health = Math.min(health, 69);
  return { health, ci, hygiene, reviewScore, dimensions: s, verdict: verdictFor(findings) };
}

// ---------- Inline comments ----------

// New-file line ranges GitHub accepts line comments on: every line inside a
// hunk, context or added.
export function commentableRanges(patch) {
  const ranges = [];
  for (const m of (patch || "").matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const len = m[2] == null ? 1 : Number(m[2]);
    if (len > 0) ranges.push([start, start + len - 1]);
  }
  return ranges;
}

// Stable across runs as long as the model keeps the file and title, which the
// review prompt asks it to do for findings it already reported.
export function findingKey(f) {
  const title = f.title.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha1").update(`${f.file}\0${title}`).digest("hex").slice(0, 12);
}

export function findingTag(meta) {
  return `<!-- ${FINDING_TAG} ${Buffer.from(JSON.stringify(meta)).toString("base64")} -->`;
}

// The metadata from one of our inline comments, or null for anything else.
export function parseFindingTag(body) {
  const m = String(body || "").match(new RegExp(`<!-- ${FINDING_TAG} ([A-Za-z0-9+/=]+) -->`));
  if (!m) return null;
  try {
    return JSON.parse(Buffer.from(m[1], "base64").toString("utf8"));
  } catch {
    return null;
  }
}

// A fence longer than any backtick run in the code, so the code can't close it.
function fence(code) {
  const longest = Math.max(0, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

export function inlineBody(f, key) {
  const out = [
    findingTag({ k: key, s: f.severity, d: f.dimension, t: f.title, f: f.file }),
    `${SEV_ICON[f.severity]} **${sanitize(f.title)}** · ${f.severity} · ${f.dimension}`,
    "",
    sanitize(f.detail),
  ];
  if (f.suggestion) {
    const code = f.suggestion.replace(/\n$/, "");
    const tick = fence(code);
    out.push("", `${tick}suggestion`, code, tick);
  }
  out.push("", "<sub>PR health bot · confirmed by a second review pass · react 👎 if this is wrong</sub>");
  return out.join("\n");
}

// Line comments for confirmed findings that land inside the diff and weren't
// already posted. A finding off the diff stays in the summary comment only.
export function inlineComments(findings, files, postedKeys = new Set()) {
  const ranges = new Map(files.map((f) => [f.filename, commentableRanges(f.patch)]));
  const seen = new Set(postedKeys);
  const out = [];
  for (const f of findings) {
    if (f.verification !== "confirmed" || !INLINE_SEVERITIES.includes(f.severity) || !f.line) continue;
    const key = findingKey(f);
    if (seen.has(key)) continue;
    const hunk = ranges.get(f.file)?.find(([a, b]) => f.line >= a && f.line <= b);
    if (!hunk) continue;
    // A multi-line comment has to sit inside one hunk. If it doesn't, anchor
    // on the first line and drop the suggestion, which replaces the range.
    const whole = f.endLine <= hunk[1];
    const end = whole ? f.endLine : f.line;
    const body = inlineBody(whole ? f : { ...f, suggestion: "" }, key);
    seen.add(key);
    out.push({
      key,
      path: f.file,
      line: end,
      side: "RIGHT",
      ...(end > f.line ? { start_line: f.line, start_side: "RIGHT" } : {}),
      body,
    });
  }
  return out;
}

// ---------- Rendering ----------

// Model output (and check names) are derived from untrusted PR content. Keep
// them as inert text: no HTML, links, @mentions, issue references, headings,
// list markers or emphasis. Paired inline code spans are kept as written
// since GitHub renders them literally.
export function sanitize(text) {
  return String(text)
    .replace(/\s*\n\s*/g, " ")
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 ? part : escapeProse(part, i)))
    .join("");
}

// URLs become code spans so they aren't clickable; the rest is escaped.
function escapeProse(s, i) {
  const out = s
    .split(/((?:https?:\/\/|www\.)\S+)/)
    .map((part, j) =>
      j % 2
        ? codeSpan(part)
        : part
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/[\\*_[\]|~`]/g, "\\$&")
            .replace(/@(?=[\w-])/g, "@​")
            .replace(/#(?=\d)/g, "#​"),
    )
    .join("");
  // Text only starts a line at the very beginning; stop it opening a heading,
  // list or quote there.
  // Markdown can't escape a digit, so an ordered list is broken at its dot.
  if (i !== 0) return out;
  return out.replace(/^(\s*)(#|[-+]\s)/, "$1\\$2").replace(/^(\s*\d+)([.)]\s)/, "$1\\$2");
}

// For text placed inside a code span we build ourselves.
export function codeSpan(text) {
  return "`" + String(text).replace(/[`\n]/g, "") + "`";
}

const SEV_ICON = { blocker: "🔴", major: "🟠", minor: "🟡", nit: "⚪" };
const VERDICT_LABEL = { ready: "✅ Ready", needs_changes: "🛠️ Needs changes", risky: "⚠️ Risky" };
const VERIFY_LABEL = { confirmed: " · ✔ verified", uncertain: " · unverified", unverified: "" };

export function grade(n) {
  if (n >= 90) return "A";
  if (n >= 80) return "B";
  if (n >= 70) return "C";
  if (n >= 60) return "D";
  return "F";
}

export function bar(n, max = 10) {
  const filled = Math.max(0, Math.min(10, Math.round((n / max) * 10)));
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

// `findings` is every finding with its verification tag, refuted ones included.
export function render({ scores, signals, checks, summary, findings, verified, inlinePosted = 0, sha }) {
  const { health, ci, hygiene, reviewScore, dimensions, verdict } = scores;
  const failing = checks.filter(
    (c) => c.status === "completed" && !["success", "neutral", "skipped"].includes(c.conclusion),
  );
  const pending = checks.filter((c) => c.status !== "completed");
  const bySeverity = (a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity);
  const kept = findings.filter((f) => f.verification !== "refuted").sort(bySeverity);
  const refuted = findings.filter((f) => f.verification === "refuted").sort(bySeverity);

  const out = [
    MARKER,
    `## PR health: **${health}/100** (${grade(health)}) · ${VERDICT_LABEL[verdict]}`,
    "",
    sanitize(summary),
    "",
    "| Component | Score | Weight |",
    "|---|---|---|",
    `| CI checks | ${ci == null ? "n/a" : `${ci}/100`} | ${ci == null ? "0%" : "30%"} |`,
    `| Diff hygiene | ${hygiene}/100 | ${ci == null ? "20%" : "15%"} |`,
    `| Code review | ${reviewScore}/100 | ${ci == null ? "80%" : "55%"} |`,
    "",
    "| Review dimension | |",
    "|---|---|",
    ...DIMENSIONS.map((k) => `| ${k} | \`${bar(dimensions[k])}\` ${dimensions[k]}/10 |`),
    "",
  ];

  if (failing.length || pending.length) {
    out.push(
      "**Checks:** " +
        [
          ...failing.map((c) => `❌ ${sanitize(c.name)}`),
          ...pending.map((c) => `⏳ ${sanitize(c.name)} (still running, counted as not passed)`),
        ].join(" · "),
      "",
    );
  }

  if (kept.length) {
    out.push(`### Findings (${kept.length})`, "");
    for (const f of kept) {
      const loc = f.line > 0 ? `${f.file}:${f.line}` : f.file;
      out.push(
        `- ${SEV_ICON[f.severity]} **${sanitize(f.title)}** · ${codeSpan(loc)}${VERIFY_LABEL[f.verification]}  \n  ${sanitize(f.detail)}`,
      );
    }
    out.push("");
  } else {
    out.push("No findings.", "");
  }

  if (!verified && findings.length) {
    out.push("_The verification pass didn't run, so these findings are unverified and none were posted on the diff._", "");
  } else if (inlinePosted) {
    out.push(`${inlinePosted} verified finding(s) posted as line comments.`, "");
  }

  if (refuted.length) {
    out.push(
      `<details><summary>Dropped by verification (${refuted.length})</summary>`,
      "",
      ...refuted.map((f) => `- ${sanitize(f.title)} · ${codeSpan(f.file)}: ${sanitize(f.reason || "no reason given")}`),
      "</details>",
      "",
    );
  }

  const caveats = [];
  if (signals.filesWithoutPatch.length) {
    caveats.push(
      `GitHub returned no patch for ${signals.filesWithoutPatch.length} large or binary file(s), ` +
        "so the counts above skip them.",
    );
  }
  if (signals.fileListTruncated) {
    caveats.push(`GitHub lists at most ${FILES_API_CAP} files per PR, so these signals are partial.`);
  }

  out.push(
    "<details><summary>Diff signals</summary>",
    "",
    `${signals.files} files, +${signals.additions} / -${signals.deletions} (lockfiles excluded); ` +
      `${signals.srcFilesChanged} source files, ${signals.testFilesChanged} test files.`,
    `Added: ${signals.addedConsoleLogs} console.log, ${signals.addedAnyTypes} \`any\`, ` +
      `${signals.addedTsIgnores} lint/ts suppressions, ${signals.addedTodos} TODOs.` +
      (signals.depsChanged ? " Dependencies changed." : "") +
      (signals.migrationsChanged ? " Migrations changed." : ""),
    ...caveats.map((c) => `\n${c}`),
    "</details>",
    "",
    `<sub>Reviewed by Claude Code · commit ${sha.slice(0, 7)}</sub>`,
  );
  return out.join("\n");
}

// Our own sticky comment: it must carry the marker and be authored by the bot,
// so a human quoting the marker can't redirect the update to their comment.
export function findOwnComment(comments, login = BOT_LOGIN) {
  return comments.find((c) => c.user?.login === login && c.body?.includes(MARKER));
}

// Our inline comments among a PR's review comments, with their metadata.
export function ownInlineComments(comments, login = BOT_LOGIN) {
  return comments
    .filter((c) => c.user?.login === login)
    .map((c) => ({ comment: c, meta: parseFindingTag(c.body) }))
    .filter((x) => x.meta?.k);
}

// ---------- Resolution stats ----------

// What became of one of our inline threads by the time its PR merged. GitHub
// marks a thread outdated once the lines it points at change, which is our
// stand-in for "fixed"; it misses fixes made somewhere else in the file.
export function threadOutcome(t) {
  if (t.isOutdated) return "fixed";
  if (t.isResolved) return "dismissed";
  return "unaddressed";
}

// threads: [{ meta: {s, d}, isOutdated, isResolved, up, down }]
export function aggregateStats(threads) {
  const row = () => ({ posted: 0, fixed: 0, dismissed: 0, unaddressed: 0, up: 0, down: 0 });
  const stats = { total: row(), bySeverity: {}, byDimension: {} };
  for (const t of threads) {
    const outcome = threadOutcome(t);
    for (const r of [
      stats.total,
      (stats.bySeverity[t.meta.s] ??= row()),
      (stats.byDimension[t.meta.d] ??= row()),
    ]) {
      r.posted++;
      r[outcome]++;
      r.up += t.up || 0;
      r.down += t.down || 0;
    }
  }
  return stats;
}

export function renderStats(stats, { prs, days }) {
  const pct = (r) => (r.posted ? `${Math.round((r.fixed / r.posted) * 100)}%` : "n/a");
  const line = (name, r) =>
    `| ${name} | ${r.posted} | ${r.fixed} | ${r.dismissed} | ${r.unaddressed} | **${pct(r)}** | ${r.up} / ${r.down} |`;
  const header = ["| | Posted | Fixed | Dismissed | Unaddressed | Resolution rate | 👍 / 👎 |", "|---|---|---|---|---|---|---|"];
  const order = (obj, keys) => keys.filter((k) => obj[k]).map((k) => line(k, obj[k]));
  const intro = [
    `## PR health bot: resolution rate, last ${days} days`,
    "",
    `${stats.total.posted} line comments across ${prs} merged PRs.`,
  ];
  if (!stats.total.posted) return intro.join("\n");
  return [
    ...intro,
    "",
    ...header,
    line("**All**", stats.total),
    "",
    "### By severity",
    "",
    ...header,
    ...order(stats.bySeverity, SEVERITIES),
    "",
    "### By dimension",
    "",
    ...header,
    ...order(stats.byDimension, DIMENSIONS),
    "",
    "Fixed means the commented lines changed before merge (GitHub marked the thread outdated). " +
      "Dismissed means the thread was resolved without that. A category with a low rate is a candidate to stop posting.",
  ].join("\n");
}
