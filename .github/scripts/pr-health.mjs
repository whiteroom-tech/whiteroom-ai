// PR health bot: scores a pull request from its CI results, some cheap
// diff heuristics, and a verified Claude review. Keeps one sticky summary
// comment up to date and posts verified findings on the diff lines.
//
// Runs from .github/workflows/pr-health.yml in three steps:
//   prior    before the review: lists findings already posted on this PR
//   prepare  after the review: hands its findings to the verification pass
//   score    after verification: scores, posts line comments and the summary
// The scoring and rendering live in pr-health-lib.mjs.
//
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER (prior, score);
// REVIEW_JSON (prepare, score); VERIFY_JSON, HEAD_SHA (score).
// Optional: CHECKS_TIMEOUT_MIN

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { gh, paginate, requireEnv } from "./pr-health-github.mjs";
import {
  MARKER,
  applyVerification,
  checksSettled,
  computeHealth,
  diffSignals,
  findOwnComment,
  inlineComments,
  ownInlineComments,
  parseReview,
  parseVerification,
  render,
} from "./pr-health-lib.mjs";

const SCRIPT_START = Date.now();
const SELF_CHECK_NAME = "PR health";
const CHECKS_TIMEOUT_MS = Number(process.env.CHECKS_TIMEOUT_MIN || 20) * 60_000;
// Other workflows can take a while to register their check runs, so don't
// stop waiting until this job has been running at least this long.
const CHECKS_GRACE_MS = 3 * 60_000;
const OUT_DIR = ".pr-health";

const repo = () => `/repos/${process.env.GITHUB_REPOSITORY}`;
const pr = () => process.env.PR_NUMBER;

// Wait for the other checks on this commit to finish so the score reflects
// them. Checks still running at the deadline count as not passed.
async function collectChecks() {
  const deadline = Date.now() + CHECKS_TIMEOUT_MS;
  for (;;) {
    const all = await paginate(`${repo()}/commits/${process.env.HEAD_SHA}/check-runs`, "check_runs");
    const self = all.find((r) => r.name === SELF_CHECK_NAME);
    const runs = all.filter((r) => r.name !== SELF_CHECK_NAME);
    const pending = runs.filter((r) => r.status !== "completed");
    // Measured from when this job started, which is before the Claude review
    // ran, so the grace period has usually passed by now.
    const startedAt = self?.started_at ? Date.parse(self.started_at) : SCRIPT_START;
    if (checksSettled({ runs, now: Date.now(), startedAt, graceMs: CHECKS_GRACE_MS }) || Date.now() > deadline) {
      return runs;
    }
    console.log(
      runs.length
        ? `waiting on ${pending.length} check(s): ${pending.map((r) => r.name).join(", ")}`
        : "no other checks yet; waiting for them to register",
    );
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

async function upsertComment(body) {
  const mine = findOwnComment(await paginate(`${repo()}/issues/${pr()}/comments`));
  if (mine) await gh(`${repo()}/issues/comments/${mine.id}`, { method: "PATCH", body: { body } });
  else await gh(`${repo()}/issues/${pr()}/comments`, { method: "POST", body: { body } });
}

// One review holding all the new line comments. If GitHub rejects the batch
// (usually one line it won't accept), fall back to posting them one by one
// so a single bad anchor doesn't lose the rest.
async function postInline(comments) {
  if (!comments.length) return 0;
  const sha = process.env.HEAD_SHA;
  const strip = ({ key, ...c }) => c;
  try {
    await gh(`${repo()}/pulls/${pr()}/reviews`, {
      method: "POST",
      body: {
        commit_id: sha,
        event: "COMMENT",
        body: `PR health: ${comments.length} verified finding(s) on the diff. Scores are in the PR health comment.`,
        comments: comments.map(strip),
      },
    });
    return comments.length;
  } catch (e) {
    console.warn(`batch review failed, posting comments one by one: ${e.message}`);
  }
  let posted = 0;
  for (const c of comments) {
    try {
      await gh(`${repo()}/pulls/${pr()}/comments`, { method: "POST", body: { ...strip(c), commit_id: sha } });
      posted++;
    } catch (e) {
      console.warn(`skipped line comment on ${c.path}:${c.line}: ${e.message}`);
    }
  }
  return posted;
}

// Findings already posted on this PR, so the reviewer can reuse their titles
// for issues that still apply. That keeps them from being posted twice.
async function prior() {
  requireEnv("GITHUB_TOKEN", "GITHUB_REPOSITORY", "PR_NUMBER");
  const posted = ownInlineComments(await paginate(`${repo()}/pulls/${pr()}/comments`));
  const list = posted.map(({ meta }) => ({ file: meta.f, title: meta.t, severity: meta.s }));
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(`${OUT_DIR}/prior-findings.json`, JSON.stringify(list, null, 2));
  console.log(`${list.length} finding(s) already posted on this PR`);
}

// Validate the review and write its findings for the verification pass.
function prepare() {
  const review = parseReview(process.env.REVIEW_JSON);
  const findings = review.findings.map(({ id, severity, dimension, file, line, endLine, title, detail }) => ({
    id,
    severity,
    dimension,
    file,
    line,
    end_line: endLine,
    title,
    detail,
  }));
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(`${OUT_DIR}/findings.json`, JSON.stringify(findings, null, 2));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `count=${findings.length}\n`);
  console.log(`${findings.length} finding(s) to verify`);
}

async function score() {
  requireEnv("GITHUB_TOKEN", "GITHUB_REPOSITORY", "PR_NUMBER", "HEAD_SHA");
  const review = parseReview(process.env.REVIEW_JSON);
  // With no findings there is nothing to verify, which counts as verified.
  const verification = review.findings.length ? parseVerification(process.env.VERIFY_JSON) : new Map();
  const findings = applyVerification(review.findings, verification);
  const kept = findings.filter((f) => f.verification !== "refuted");

  const [files, checks, reviewComments] = await Promise.all([
    paginate(`${repo()}/pulls/${pr()}/files`),
    collectChecks(),
    paginate(`${repo()}/pulls/${pr()}/comments`),
  ]);
  const signals = diffSignals(files);
  const scores = computeHealth(kept, checks, signals);

  const postedKeys = new Set(ownInlineComments(reviewComments).map((x) => x.meta.k));
  const inlinePosted = await postInline(inlineComments(kept, files, postedKeys));

  const body = render({
    scores,
    signals,
    checks,
    summary: review.summary,
    findings,
    verified: verification != null,
    inlinePosted,
    sha: process.env.HEAD_SHA,
  });
  await upsertComment(body);
  const refuted = findings.length - kept.length;
  console.log(
    `health ${scores.health}/100, verdict ${scores.verdict}, ${kept.length} findings kept, ` +
      `${refuted} refuted, ${inlinePosted} posted inline`,
  );

  // Surface the score in the Actions run summary too.
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, body.replace(MARKER, "") + "\n");
  }
}

const commands = { prior, prepare, score };
const cmd = process.argv[2] || "score";
if (!commands[cmd]) {
  console.error(`unknown command ${cmd}; expected one of ${Object.keys(commands).join(", ")}`);
  process.exit(1);
}
await commands[cmd]();
