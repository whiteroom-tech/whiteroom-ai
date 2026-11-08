export const SANDBOX_OPEN_STATES = ['opening', 'opens-later', 'opens-tomorrow', 'failed', 'cleared'] as const;
export type SandboxOpenState = (typeof SANDBOX_OPEN_STATES)[number];
