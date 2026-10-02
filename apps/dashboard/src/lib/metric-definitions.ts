// Plain-language definitions for the savings stats, shown behind an ⓘ next to
// each label. They describe the math in lib/analytics-metrics.ts and
// lib/format.ts; if that math changes, update these.

import { KWH_PER_TOKEN } from './format';

const KWH_PER_MILLION = +(KWH_PER_TOKEN * 1_000_000).toFixed(3);

/** Live feed help; the retention comes from the engine (ttlHours). */
export function liveFeedHelp(ttlHours: number): string {
  return `Everything the agents actually said and did, including the web pages they opened and the exact inputs they gave their tools. It is private content, so it stays hidden until you open it and is deleted after ${ttlHours} hours.`;
}

/**
 * Hover help for labels, verbatim from the redesign handoff (screen 10,
 * "Labels and hover help"). Shown through the ⓘ Hint next to each label.
 */
export const HELP = {
  smallerHandovers: "When an agent's shift ends, WhiteRoom passes its work to a fresh session as short notes instead of the full history. This is how much smaller those notes are, on average.",
  savings: `Money not spent because handovers keep each agent's notes short. Shown as an upper limit, so the real figure can be lower. Energy is the saved tokens × ${KWH_PER_MILLION} kWh per million tokens, an estimate.`,
  agentsWorking: 'Agents doing a task right now, out of all the agents connected to this fleet.',
  modelCallsToday: 'Each time an agent asks the AI model something, that counts as one call. Counted since midnight UTC.',
  spendToday: "What today's model calls cost, at your AI provider's prices.",
  needsYou: 'Things only a person can decide: an agent that was paused or stopped, or a run that did something unusual. When this is empty, nothing needs you.',
  agents: 'Every agent connected to this fleet. Working: doing a task. Resting: a short planned break between shifts. Idle: waiting for work. Paused or Stopped: held by a rule or a person.',
  activity: 'The latest things that happened across the fleet, in plain words.',
  runs: 'A run is one stretch of work by one agent, from when it starts until it stops or hands over. Each row is one run.',
  whatStoodOut: 'The one thing worth knowing about this run: something unusual, a rule stepping in, or a person stopping it.',
  whatHappened: 'Every step of this run in order: the model calls, tools used, rules that stepped in, and handovers.',
  claimCheck: 'Compares what the agent said it did with what it actually did. For example, it said it saved a file: did a save really happen?',
  unusualBehaviour: 'Runs where an agent did something unusual, like repeating the same call or failing several calls in a row. These are flags: nothing is blocked because of them.',
  ruleActions: 'Times one of your rules stepped in: it told you, blocked a call, or paused or stopped an agent.',
  currentShift: 'Agents work in short shifts. At the end of each one they pass their notes to a fresh session, which keeps them fast and cheap.',
  handoverNotes: 'What the agent passed to its next shift: where it is, what is left to do, and anything to watch out for.',
  taskType: 'A short name for what this agent does. It is used to compare costs between agents doing the same kind of work.',
  recentRuns: "This agent's latest stretches of work, newest first.",
  rulesThatApply: 'The rules from Controls that cover this agent, and what each one has done to it lately.',
  spend: "What the fleet's model calls cost in this time range.",
  failedCalls: 'The share of model calls that came back with an error.',
  costTracking: 'How fast the fleet is spending, and where today will end against your daily budget.',
  byAgent: 'The same numbers, one row per agent.',
  agentHealthCheck: "An automatic review of each agent's recent work: cost, errors and habits.",
  recommendations: 'Changes that would save money or prevent problems, based on how your agents have been working.',
  historyKept: 'How long WhiteRoom keeps the record of what your agents did. Older records are deleted automatically.',
  alerts: 'Where WhiteRoom sends a message when a rule says Just tell me, when a run is flagged, or when a claim does not match the record.',
  slackWebhook: 'A private link from Slack that lets WhiteRoom post into one channel.',
  pastTests: 'Your earlier Sandbox tests: when each one ended, whether its checks passed, and how many tasks it ran.',
  shift: 'One stretch of an agent’s working time.',
  watchOnlyEnforce: 'Watch only: a rule notes what it would have done but changes nothing. Enforce: it really steps in.',
  tryLast7Days: 'Replays last week’s real activity against a rule and shows what it would have done. Nothing changes.',
} as const;
