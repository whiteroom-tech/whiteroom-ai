// Pure pieces of the PR health bot: review parsing, scoring and rendering.
// pr-health.mjs does the GitHub I/O; pr-health.test.mjs covers this file.

export const MARKER = "<!-- whiteroom-pr-health -->";
// Comments posted with the workflow's github.token are authored by this bot.
export const BOT_LOGIN = "github-actions[bot]";

const SEVERITIES = ["blocker", "major", "minor", "nit"];
const VERDICTS = ["ready", "needs_changes", "risky"];
const DIMENSIONS = ["correctness", "security", "maintainability", "testing"];

// GitHub's pulls/files endpoint stops listing files here.
export const FILES_API_CAP = 3000;

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
  if (!VERDICTS.includes(r.verdict)) throw new Error(`review.verdict: expected one of ${VERDICTS.join(", ")}`);
  if (!r.scores || typeof r.scores !== "object") throw new Error("review.scores: expected an object");
  if (!Array.isArray(r.findings)) throw new Error("review.findings: expected an array");

  const scores = {};
  for (const k of DIMENSIONS) {
    const v = r.scores[k];
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`review.scores.${k}: expected a number, got ${JSON.stringify(v)}`);
    scores[k] = Math.max(0, Math.min(10, Math.round(v)));
  }

  const findings = r.findings.map((f, i) => {
    const at = `review.findings[${i}]`;
    if (!f || typeof f !== "object") throw new Error(`${at}: expected an object`);
    for (const k of ["file", "title", "detail"]) {
      if (typeof f[k] !== "string") throw new Error(`${at}.${k}: expected a string`);
    }
    if (!SEVERITIES.includes(f.severity)) throw new Error(`${at}.severity: expected one of ${SEVERITIES.join(", ")}`);
    const line = Number.isInteger(f.line) && f.line > 0 ? f.line : 0;
    return { severity: f.severity, file: f.file, line, title: f.title, detail: f.detail };
  });

  return { summary: r.summary, verdict: r.verdict, scores, findings };
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

export function computeHealth(review, checks, signals) {
  const s = review.scores;
  const reviewScore = Math.round(((s.correctness * 2 + s.security * 2 + s.maintainability + s.testing) / 60) * 100);
  const ci = ciScore(checks);
  const hygiene = hygieneScore(signals);
  let health = Math.round(
    ci == null ? hygiene * 0.2 + reviewScore * 0.8 : ci * 0.3 + hygiene * 0.15 + reviewScore * 0.55,
  );
  // A blocker or a red or unfinished check shouldn't be averaged away by good
  // scores elsewhere.
  if (review.findings.some((f) => f.severity === "blocker")) health = Math.min(health, 59);
  if (ci != null && ci < 100) health = Math.min(health, 69);
  return { health, ci, hygiene, reviewScore };
}

// ---------- Rendering ----------

// Model output (and check names) are derived from untrusted PR content. Keep
// them as inert text: no HTML, no links, no @mentions, no markdown emphasis.
// Inline code spans are kept as written since GitHub renders them literally.
export function sanitize(text) {
  return String(text)
    .replace(/\s*\n\s*/g, " ")
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 ? part : escapeProse(part)))
    .join("");
}

// URLs become code spans so they aren't clickable; the rest is escaped.
function escapeProse(s) {
  return s
    .split(/(https?:\/\/\S+)/)
    .map((part, i) =>
      i % 2
        ? codeSpan(part)
        : part
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/[\\*_[\]|~]/g, "\\$&")
            .replace(/@(?=[\w-])/g, "@​"),
    )
    .join("");
}

// For text placed inside a code span we build ourselves.
export function codeSpan(text) {
  return "`" + String(text).replace(/[`\n]/g, "") + "`";
}

const SEV_ICON = { blocker: "🔴", major: "🟠", minor: "🟡", nit: "⚪" };
const VERDICT_LABEL = { ready: "✅ Ready", needs_changes: "🛠️ Needs changes", risky: "⚠️ Risky" };

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

export function render({ scores: { health, ci, hygiene, reviewScore }, signals, checks, review: r, sha }) {
  const failing = checks.filter(
    (c) => c.status === "completed" && !["success", "neutral", "skipped"].includes(c.conclusion),
  );
  const pending = checks.filter((c) => c.status !== "completed");
  const findings = [...r.findings].sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));

  const out = [
    MARKER,
    `## PR health: **${health}/100** (${grade(health)}) · ${VERDICT_LABEL[r.verdict]}`,
    "",
    sanitize(r.summary),
    "",
    "| Component | Score | Weight |",
    "|---|---|---|",
    `| CI checks | ${ci == null ? "n/a" : `${ci}/100`} | ${ci == null ? "0%" : "30%"} |`,
    `| Diff hygiene | ${hygiene}/100 | ${ci == null ? "20%" : "15%"} |`,
    `| Code review | ${reviewScore}/100 | ${ci == null ? "80%" : "55%"} |`,
    "",
    "| Review dimension | |",
    "|---|---|",
    ...DIMENSIONS.map((k) => `| ${k} | \`${bar(r.scores[k])}\` ${r.scores[k]}/10 |`),
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

  if (findings.length) {
    out.push(`### Findings (${findings.length})`, "");
    for (const f of findings) {
      const loc = f.line > 0 ? `${f.file}:${f.line}` : f.file;
      out.push(`- ${SEV_ICON[f.severity]} **${sanitize(f.title)}** · ${codeSpan(loc)}  \n  ${sanitize(f.detail)}`);
    }
    out.push("");
  } else {
    out.push("No findings.", "");
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
export function findOwnComment(comments) {
  return comments.find((c) => c.user?.login === BOT_LOGIN && c.body?.includes(MARKER));
}
