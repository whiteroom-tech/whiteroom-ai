// Plain-language definitions shown behind an ⓘ next to each label: what a
// figure measures, never how WhiteRoom works it out.

/** Live feed help; the retention comes from the engine (ttlHours). */
export function liveFeedHelp(ttlHours: number): string {
  return `Everything the agents actually said and did, including the web pages they opened and the exact inputs they gave their tools, with API keys, passwords and other credentials removed. It is private content, so it stays hidden until you open it and is deleted after ${ttlHours} hours.`;
}

/** Hover help for labels, shown through the ⓘ Hint next to each label. */
export const HELP = {
  smallerContext: "How much smaller your agents' context is with WhiteRoom than their full history, on average, over all time.",
  hourlySpend: 'What your agents spend per hour, on average, over the range shown.',
  typicalResponse: 'The median time a model call takes, start to finish: half of calls are faster.',
  savings: 'An estimate of the money WhiteRoom saved your agents in the range shown, at the prices they pay. A "+" means some tokens had no price on file.',
  agentsWorking: 'Agents doing a task right now, out of all the agents connected to this fleet.',
  modelCallsToday: 'Each time an agent asks the AI model something, that counts as one call. Counted since midnight in your time zone.',
  spendToday: "What today's model calls cost, at your AI provider's prices.",
  needsYou: 'Things only a person can decide: an agent that was paused or stopped, or a run that did something unusual. When this is empty, nothing needs you.',
  agents: 'Every agent connected to this fleet. Working: doing a task. Resting: a short planned break. Idle: waiting for work. Paused or Stopped: held by a rule or a person.',
  activity: 'The latest things that happened across the fleet, in plain words.',
  runs: 'A run is one stretch of work by one agent, from when it starts until it stops. Each row is one run.',
  whatStoodOut: 'The one thing worth knowing about this run: something unusual, a rule stepping in, or a person stopping it.',
  whatHappened: 'Every step of this run in order: the model calls, tools used, rules that stepped in, and when it saved progress.',
  claimCheck: 'Compares what the agent said it did with what it actually did. For example, it said it saved a file: did a save really happen?',
  unusualBehaviour: 'Runs where an agent did something unusual, like repeating the same call or failing several calls in a row. These are flags: nothing is blocked because of them.',
  ruleActions: 'Times one of your rules stepped in: it alerted you, blocked a call, or paused or stopped an agent.',
  currentRun: 'What the agent is working on now.',
  progressNotes: 'Where the agent is, what is left to do, and anything to watch out for.',
  taskType: 'A short name for what this agent does. It is used to compare costs between agents doing the same kind of work.',
  recentRuns: "This agent's latest stretches of work, newest first.",
  rulesThatApply: 'The rules from Controls that cover this agent, and what each one has done to it lately.',
  spend: "What the fleet's model calls cost in this time range.",
  failedCalls: 'The share of model calls that came back with an error.',
  costTracking: 'How fast the fleet spends in the hours it works (last 14 days), and about how many more calls today’s budget covers. The budget resets at your midnight.',
  agentHealthCheck: "An automatic review of each agent's recent work: cost, errors and habits.",
  recommendations: 'Changes that would save money or prevent problems, based on how your agents have been working.',
  historyKept: 'How long WhiteRoom keeps the record of what your agents did. Older records are deleted automatically.',
  alerts: 'Where WhiteRoom sends your alerts: when a rule alerts you or a run is flagged.',
  slackWebhook: 'A private link from Slack that lets WhiteRoom post into one channel.',
  pastTests: 'Your earlier Sandbox tests: when each one ended, whether its checks passed (Not tested means no call came back OK), and how many tasks it ran.',
  shift: 'One stretch of an agent’s working time.',
  recordOnlyBlock: 'Record only: a rule records what it would have done and lets the call through. Block: it acts on the call.',
  tryLast7Days: 'Replays last week’s real activity against a rule and shows what it would have done. Nothing changes.',
} as const;
