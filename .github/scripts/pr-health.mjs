// PR health bot: scores a pull request from its CI results, some cheap
// diff heuristics, and a Claude review, then keeps one sticky comment up
// to date on the PR.
//
// Runs from .github/workflows/pr-health.yml after the Claude review step.
// The scoring and rendering live in pr-health-lib.mjs.
//
// Env: REVIEW_JSON, GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, HEAD_SHA
// Optional: CHECKS_TIMEOUT_MIN

import { appendFileSync } from "node:fs";
import {
  MARKER,
  checksSettled,
  computeHealth,
  diffSignals,
  findOwnComment,
  parseReview,
  render,
} from "./pr-health-lib.mjs";

const SCRIPT_START = Date.now();
const SELF_CHECK_NAME = "PR health";
const CHECKS_TIMEOUT_MS = Number(process.env.CHECKS_TIMEOUT_MIN || 20) * 60_000;
// Other workflows can take a while to register their check runs, so don't
// stop waiting until this job has been running at least this long.
const CHECKS_GRACE_MS = 3 * 60_000;

const { GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, HEAD_SHA } = process.env;
for (const k of ["GITHUB_TOKEN", "GITHUB_REPOSITORY", "PR_NUMBER", "HEAD_SHA"]) {
  if (!process.env[k]) {
    console.error(`missing env ${k}`);
    process.exit(1);
  }
}

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
// them. Checks still running at the deadline count as not passed.
async function collectChecks() {
  const deadline = Date.now() + CHECKS_TIMEOUT_MS;
  for (;;) {
    const all = await paginate(`${repo}/commits/${HEAD_SHA}/check-runs`, "check_runs");
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
  const mine = findOwnComment(await paginate(`${repo}/issues/${PR_NUMBER}/comments`));
  if (mine) await gh(`${repo}/issues/comments/${mine.id}`, { method: "PATCH", body: { body } });
  else await gh(`${repo}/issues/${PR_NUMBER}/comments`, { method: "POST", body: { body } });
}

const review = parseReview(process.env.REVIEW_JSON);
const [files, checks] = await Promise.all([paginate(`${repo}/pulls/${PR_NUMBER}/files`), collectChecks()]);
const signals = diffSignals(files);
const scores = computeHealth(review, checks, signals);

const body = render({ scores, signals, checks, review, sha: HEAD_SHA });
await upsertComment(body);
console.log(`health ${scores.health}/100, verdict ${review.verdict}, ${review.findings.length} findings`);

// Surface the score in the Actions run summary too.
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, body.replace(MARKER, "") + "\n");
}
