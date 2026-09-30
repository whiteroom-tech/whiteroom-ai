// Resolution rate of the PR health bot's line comments on recently merged
// PRs: how many led to a code change before merge, by severity and dimension.
// Runs from .github/workflows/pr-health-stats.yml.
//
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY. Optional: DAYS (default 30)

import { appendFileSync } from "node:fs";
import { graphql, requireEnv } from "./pr-health-github.mjs";
import { BOT_LOGIN, aggregateStats, parseFindingTag, renderStats } from "./pr-health-lib.mjs";

requireEnv("GITHUB_TOKEN", "GITHUB_REPOSITORY");
const days = Number(process.env.DAYS || 30);
const since = Date.now() - days * 86_400_000;
const [owner, name] = process.env.GITHUB_REPOSITORY.split("/");
// GraphQL reports bot authors without the [bot] suffix.
const botLogin = BOT_LOGIN.replace(/\[bot\]$/, "");

const QUERY = `
  query($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequests(states: MERGED, first: 25, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          mergedAt
          updatedAt
          reviewThreads(first: 100) {
            nodes {
              isResolved
              isOutdated
              comments(first: 1) {
                nodes {
                  author { login }
                  body
                  up: reactions(content: THUMBS_UP) { totalCount }
                  down: reactions(content: THUMBS_DOWN) { totalCount }
                }
              }
            }
          }
        }
      }
    }
  }`;

const threads = [];
let prs = 0;
// Ordered by last update, which is never before the merge, so once a page
// reaches PRs untouched since the window opened there is nothing left.
for (let after = null, done = false; !done; ) {
  const page = (await graphql(QUERY, { owner, name, after })).repository.pullRequests;
  for (const p of page.nodes) {
    if (Date.parse(p.updatedAt) < since) {
      done = true;
      break;
    }
    if (Date.parse(p.mergedAt) < since) continue;
    prs++;
    for (const t of p.reviewThreads.nodes) {
      const c = t.comments.nodes[0];
      if (c?.author?.login !== botLogin) continue;
      const meta = parseFindingTag(c.body);
      if (!meta?.s || !meta?.d) continue;
      threads.push({ meta, isOutdated: t.isOutdated, isResolved: t.isResolved, up: c.up.totalCount, down: c.down.totalCount });
    }
  }
  if (!page.pageInfo.hasNextPage) done = true;
  after = page.pageInfo.endCursor;
}

const report = renderStats(aggregateStats(threads), { prs, days });
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + "\n");
