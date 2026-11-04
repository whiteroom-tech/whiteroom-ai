// What a rule does in Enforce when the engine didn't say (older engines sent
// no response): Block, except Sensitive data, which has no Block and removes
// what it finds. One place, so every label, tag and dialog agrees.

import type { GovernanceResponse, GovernanceRuleType } from '@/lib/whiteroom/types';

export const defaultResponse = (ruleType?: GovernanceRuleType): GovernanceResponse => (ruleType === 'sensitive_data' ? 'redact' : 'block');

/** The rule's response, or its type's default. */
export const responseOf = (r: { ruleType?: GovernanceRuleType; response?: GovernanceResponse }): GovernanceResponse => r.response ?? defaultResponse(r.ruleType);
