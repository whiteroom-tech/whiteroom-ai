// Performance › Cost tracking: the line shown when a daily budget runs out.
import { describe, expect, it } from 'vitest';
import { budgetNotice } from '@/lib/cost-tracking';

const base = {
  budgetUsd: 5, spentTodayUsd: 1, remainingTasks: 10, remainingTasksReason: 'available' as const, costUnavailable: false,
  dollarRemainingTasks: 10, dollarRemainingTasksReason: 'available' as const, tokenRemainingTasks: null, tokenRemainingTasksReason: 'budget_missing' as const,
};

describe('budget notice', () => {
  it('stays quiet while there is room, or with no budget set', () => {
    expect(budgetNotice(base)).toBeNull();
    expect(budgetNotice({ ...base, budgetUsd: null, spentTodayUsd: 9, dollarRemainingTasks: null, dollarRemainingTasksReason: 'budget_missing' })).toBeNull();
  });
  it('says the $ budget is used up, and that agents keep running', () => {
    expect(budgetNotice({ ...base, spentTodayUsd: 5.4, dollarRemainingTasks: 0 })).toBe('Today’s $ budget is used up. Your agents are still running.');
    // No task-cost estimate yet, but spend is past the budget: still said.
    expect(budgetNotice({ ...base, spentTodayUsd: 6, dollarRemainingTasks: null, dollarRemainingTasksReason: 'task_type_missing' })).toBe('Today’s $ budget is used up. Your agents are still running.');
  });
  it('says the token budget is used up', () => {
    expect(budgetNotice({ ...base, tokenRemainingTasks: 0, tokenRemainingTasksReason: 'available' })).toBe('Today’s token budget is used up. Your agents are still running.');
  });
  it('both at once', () => {
    expect(budgetNotice({ ...base, dollarRemainingTasks: 0, tokenRemainingTasks: 0, tokenRemainingTasksReason: 'available' })).toBe('Today’s $ and token budgets are used up. Your agents are still running.');
  });
});
