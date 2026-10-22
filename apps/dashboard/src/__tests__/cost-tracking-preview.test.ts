// Performance › Cost tracking in the dev preview: the sample fleet is never read from or written to.
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/whiteroom/client', () => ({
  performanceCostForecast: vi.fn(async () => ({ error: 'real read' })),
  setBudgetUsd: vi.fn(async () => ({ success: true })),
  setTokenBudget: vi.fn(async () => ({ success: true })),
}));

import * as client from '@/lib/whiteroom/client';
import { costTrackingApi } from '@/app/(citadel)/performance/_components/CostTracking';
import type { PerformanceCostForecastResult } from '@/lib/whiteroom/types';

const sample = { fleetId: 'acme-claims-prod', budgetUsd: 5, spendToDateUsd: 1, burnRateUsdPerHour: 0.01, remainingTasks: 3, costUnavailable: false, tokensPerHour: null, tokenBudget: null } as PerformanceCostForecastResult;

describe('cost tracking api', () => {
  it('with preview data: reads return the sample and saves never reach the API', async () => {
    const api = costTrackingApi(sample);
    expect(await api.forecast('acme-claims-prod')).toEqual(sample);
    expect(await api.saveBudgetUsd('acme-claims-prod', 10)).toEqual({ success: true, fleetId: 'acme-claims-prod', budgetUsd: 10 });
    expect(await api.saveTokenBudget('acme-claims-prod', 5000)).toEqual({ success: true, fleetId: 'acme-claims-prod', tokenBudget: 5000 });
    expect(client.performanceCostForecast).not.toHaveBeenCalled();
    expect(client.setBudgetUsd).not.toHaveBeenCalled();
    expect(client.setTokenBudget).not.toHaveBeenCalled();
    // The edit sticks: the next read has the saved budgets, not the original sample.
    expect(await api.forecast('acme-claims-prod')).toMatchObject({ budgetUsd: 10, tokenBudget: 5000 });
  });

  it('without preview data: the real reads and saves', async () => {
    const api = costTrackingApi();
    await api.forecast('fleet-1', 'key');
    await api.saveBudgetUsd('fleet-1', 10, 'key');
    expect(client.performanceCostForecast).toHaveBeenCalledWith('fleet-1', undefined, 'key');
    expect(client.setBudgetUsd).toHaveBeenCalledWith('fleet-1', 10, 'key');
  });
});
