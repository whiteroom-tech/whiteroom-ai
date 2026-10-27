// @vitest-environment happy-dom
// Performance › Cost prediction (renamed from Cost tracking): its heading, the
// calls-left wording, and the error a failed read shows.
import { describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import type { PerformanceCostForecastResult } from '@/lib/whiteroom/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('@/lib/whiteroom/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/whiteroom/client')>()),
  performanceCostForecast: vi.fn(async () => ({ error: 'engine down' })),
}));
const { CostTrackingSection } = await import('@/app/(citadel)/performance/_components/CostTracking');

async function render(props: Parameters<typeof CostTrackingSection>[0]) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(h(CostTrackingSection, props)); });
  await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
  const text = el.textContent ?? '';
  root.unmount();
  return text;
}

describe('Cost prediction', () => {
  it('is headed Cost prediction and counts calls left', async () => {
    const sample = { fleetId: 'f', budgetUsd: 5, spentTodayUsd: 1, burnRateUsdPerHour: 0.5, remainingTasks: 12, remainingTasksReason: 'available', costUnavailable: false, tokensPerHour: null, tokenBudget: null } as PerformanceCostForecastResult;
    const text = await render({ fleetId: 'f', preview: sample });
    expect(text).toContain('Cost prediction');
    expect(text).toContain('calls left');
    expect(text).not.toMatch(/tasks left/);
  });

  it('says plainly when the prediction couldn’t be read', async () => {
    const text = await render({ fleetId: 'f', authKey: 'k' });
    expect(text).toContain('Cost prediction');
    expect(text).toContain('Couldn’t load the cost prediction: engine down');
  });
});
