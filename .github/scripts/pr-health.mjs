// PR health bot: scores a pull request from its CI results, some cheap
// diff heuristics, and a Claude review, then keeps one sticky comment up
// to date on the PR.
//
// Runs from .github/workflows/pr-health.yml after the Claude review step.
//
// Env: REVIEW_JSON, GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, HEAD_SHA
// Optional: CHECKS_TIMEOUT_MIN


const MARKER = "<!-- whiteroom-pr-health -->";
const SELF_CHECK_NAME = "PR health";
const CHECKS_TIMEOUT_MS = Number(process.env.CHECKS_TIMEOUT_MIN || 20) * 60_000;

const { GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, HEAD_SHA } = process.env;
for (const k of ["REVIEW_JSON", "GITHUB_TOKEN", "GITHUB_REPOSITORY", "PR_NUMBER", "HEAD_SHA"]) {
  if (!process.env[k]) {
    console.error(`missing env ${k}`);
    process.exit(1);
  }
}

// ---------- GitHub ----------

async function gh(path, { method = "GET", body } = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function paginate(path, key) {
  const out = [];
  for (let page = 1; ; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const data = await gh(`${path}${sep}per_page=100&page=${page}`);
    const items = key ? data[key] : data;
    out.push(...items);
    if (items.length < 100) return out;
  }
}

const repo = `/repos/${GITHUB_REPOSITORY}`;

// Wait for the other checks on this commit to finish so the score reflects
// them. Checks still running at the deadline are reported as pending.
async function collectChecks() {
  const deadline = Date.now() + CHECKS_TIMEOUT_MS;
  for (;;) {
    const runs = (await paginate(`${repo}/commits/${HEAD_SHA}/check-runs`, "check_runs")).filter(
      (r) => r.name !== SELF_CHECK_NAME,
    );
    const pending = runs.filter((r) => r.status !== "completed");
    if (pending.length === 0 || Date.now() > deadline) return runs;
    console.log(`waiting on ${pending.length} check(s): ${pending.map((r) => r.name).join(", ")}`);
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

// ---------- Deterministic signals ----------

const TEST_RE = /(__tests__|\.test\.|\.spec\.|\/tests?\/)/;
const SRC_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const LOCK_RE = /(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/;

function diffSignals(files) {
  const code = files.filter((f) => !LOCK_RE.test(f.filename));
  const additions = code.reduce((n, f) => n + f.additions, 0);
  const deletions = code.reduce((n, f) => n + f.deletions, 0);
  const srcChanged = code.filter((f) => SRC_RE.test(f.filename) && !TEST_RE.test(f.filename));
  const testsChanged = code.filter((f) => TEST_RE.test(f.filename));

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

// 0-100 from CI, 0-100 from diff hygiene. The review score comes from Claude.
function ciScore(checks) {
  const done = checks.filter((c) => c.status === "completed" && c.conclusion !== "skipped");
  if (done.length === 0) return null;
  const good = done.filter((c) => ["success", "neutral"].includes(c.conclusion)).length;
  return Math.round((good / done.length) * 100);
}

function hygieneScore(s) {
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

// ---------- Claude review ----------

// The review itself is done by claude-code-action in the previous workflow
// step, which hands us JSON matching pr-health-schema.json.
function loadReview() {
  const raw = process.env.REVIEW_JSON;
  if (!raw) throw new Error("REVIEW_JSON is empty; the Claude review step produced no structured output");
  const review = JSON.parse(raw);
  // The schema can't express ranges, so clamp here.
  for (const k of Object.keys(review.scores)) review.scores[k] = Math.max(0, Math.min(10, review.scores[k]));
  return review;
}

// ---------- Report ----------

const SEV_ICON = { blocker: "🔴", major: "🟠", minor: "🟡", nit: "⚪" };
const VERDICT = { ready: "✅ Ready", needs_changes: "🛠️ Needs changes", risky: "⚠️ Risky" };

function grade(n) {
  if (n >= 90) return "A";
  if (n >= 80) return "B";
  if (n >= 70) return "C";
  if (n >= 60) return "D";
  return "F";
}

function bar(n, max = 10) {
  const filled = Math.round((n / max) * 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

function render({ health, ci, hygiene, reviewScore, signals, checks, review: r }) {
  const failing = checks.filter((c) => c.status === "completed" && !["success", "neutral", "skipped"].includes(c.conclusion));
  const pending = checks.filter((c) => c.status !== "completed");
  const findings = [...r.findings].sort(
    (a, b) => Object.keys(SEV_ICON).indexOf(a.severity) - Object.keys(SEV_ICON).indexOf(b.severity),
  );

  const out = [
    MARKER,
    `## PR health: **${health}/100** (${grade(health)}) · ${VERDICT[r.verdict]}`,
    "",
    r.summary,
    "",
    "| Component | Score | Weight |",
    "|---|---|---|",
    `| CI checks | ${ci ?? "n/a"}${ci == null ? "" : "/100"} | ${ci == null ? "0%" : "30%"} |`,
    `| Diff hygiene | ${hygiene}/100 | ${ci == null ? "20%" : "15%"} |`,
    `| Code review | ${reviewScore}/100 | ${ci == null ? "80%" : "55%"} |`,
    "",
    "| Review dimension | |",
    "|---|---|",
    ...Object.entries(r.scores).map(([k, v]) => `| ${k} | \`${bar(v)}\` ${v}/10 |`),
    "",
  ];

  if (failing.length || pending.length) {
    out.push("**Checks:** " + [
      ...failing.map((c) => `❌ [${c.name}](${c.html_url})`),
      ...pending.map((c) => `⏳ ${c.name} (still running)`),
    ].join(" · "), "");
  }

  if (findings.length) {
    out.push(`### Findings (${findings.length})`, "");
    for (const f of findings) {
      const loc = f.line > 0 ? `${f.file}:${f.line}` : f.file;
      out.push(`- ${SEV_ICON[f.severity]} **${f.title}** · \`${loc}\`  \n  ${f.detail.replace(/\n+/g, " ")}`);
    }
    out.push("");
  } else {
    out.push("No findings.", "");
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
    "</details>",
    "",
    `<sub>Reviewed by Claude Code · commit ${HEAD_SHA.slice(0, 7)}</sub>`,
  );
  return out.join("\n");
}

async function upsertComment(body) {
  const comments = await paginate(`${repo}/issues/${PR_NUMBER}/comments`);
  const mine = comments.find((c) => c.body?.includes(MARKER));
  if (mine) await gh(`${repo}/issues/comments/${mine.id}`, { method: "PATCH", body: { body } });
  else await gh(`${repo}/issues/${PR_NUMBER}/comments`, { method: "POST", body: { body } });
}

// ---------- Main ----------

const review = loadReview();
const [files, checks] = await Promise.all([paginate(`${repo}/pulls/${PR_NUMBER}/files`), collectChecks()]);

const signals = diffSignals(files);
const s = review.scores;
const reviewScore = Math.round(((s.correctness * 2 + s.security * 2 + s.maintainability + s.testing) / 60) * 100);
const ci = ciScore(checks);
const hygiene = hygieneScore(signals);
let health = Math.round(
  ci == null ? hygiene * 0.2 + reviewScore * 0.8 : ci * 0.3 + hygiene * 0.15 + reviewScore * 0.55,
);
// A blocker or a red check shouldn't be averaged away by good scores elsewhere.
if (review.findings.some((f) => f.severity === "blocker")) health = Math.min(health, 59);
if (ci != null && ci < 100) health = Math.min(health, 69);

const body = render({ health, ci, hygiene, reviewScore, signals, checks, review });
await upsertComment(body);
console.log(`health ${health}/100, verdict ${review.verdict}, ${review.findings.length} findings`);

// Surface the score in the Actions run summary too.
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, body.replace(MARKER, "") + "\n");
}
