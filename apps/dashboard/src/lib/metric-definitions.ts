// Plain-language definitions shown behind an ⓘ next to each label: what a
// figure measures, never how WhiteRoom works it out.

/** Live feed help; the retention comes from the engine (ttlHours). */
export function liveFeedHelp(ttlHours: number): string {
  return `Everything the agents actually said and did, including the web pages they opened and the exact inputs they gave their tools, with API keys, passwords and other credentials removed. It is private content, so it stays hidden until you open it and is deleted after ${ttlHours} hours.`;
}

/** Hover help for labels, shown through the ⓘ Hint next to each label. */
export const HELP = {
  smallerContext: "How much less input your agents sent to the models with WhiteRoom than they would have without it, in the range shown. Input includes cached input; output isn't counted.",
  hourlySpend: 'What your agents spend in an hour while they work: the average over recent hours with model calls. Quiet hours don’t pull it down.',
  modelCalls: 'Each time an agent asks the AI model something, that counts as one call.',
  typicalResponse: 'The median time a model call takes, start to finish: half of calls are faster.',
  savings: 'An estimate of the money WhiteRoom saved your agents in the range shown, at the prices they pay. A "+" means some tokens had no price on file.',
  agentsWorking: 'Agents doing a task right now, out of all the agents connected to this fleet.',
  modelCallsToday: 'Each time an agent asks the AI model something, that counts as one call. Counted since midnight in your time zone.',
  spendToday: "What today's model calls cost, at your AI provider's prices.",
  agents: 'Every agent connected to this fleet. Working: making calls now. Waiting: connected, waiting for work. Paused or Stopped: held by a rule or a person until someone resumes it.',
  whatStoodOut: 'The one thing worth knowing about this run: something unusual, a rule stepping in, or a person stopping it.',
  claimCheck: 'Compares what the agent said it did with what it actually did. For example, it said it saved a file: did a save really happen?',
  unusualBehaviour: 'Runs where an agent did something unusual, like repeating the same call or failing several calls in a row. These are flags: nothing is blocked because of them.',
  ruleActions: 'Times one of your rules stepped in: it alerted you, blocked a call, or paused or stopped an agent.',
  rulesThatApply: 'The rules from Controls that cover this agent, and what each one has done to it lately.',
  spend: "What the fleet's model calls cost in this time range.",
  failedCalls: 'The share of model calls that came back with an error.',
  agentHealthCheck: "An automatic review of each agent's recent work: cost, errors and habits.",
  recommendations: 'Changes that would save money or prevent problems, based on how your agents have been working.',
  historyKept: 'How long WhiteRoom keeps the record of what your agents did. Older records are deleted automatically.',
  alerts: 'Where WhiteRoom sends your alerts: when a rule alerts you or a run is flagged.',
  slackWebhook: 'A private link from Slack that lets WhiteRoom post into one channel.',
  pastTests: 'Your earlier Sandbox tests: when each one ended, whether it passed, and how many tasks it ran. Tests where nothing was checked aren’t listed.',
  shift: 'One stretch of an agent’s working time.',
  recordOnlyBlock: 'Watch: a rule records what it would have done and lets the call through. Enforce: it acts on the call.',
  tryLast7Days: 'Replays last week’s real activity against a rule and shows what it would have done. Nothing changes.',
} as const;
