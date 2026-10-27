// Performance › the last overview per fleet and range, shown at once on a return visit.
import { describe, it, expect, beforeEach } from 'vitest';
import { clearSnapshots, readSnapshot, saveSnapshot, updateSnapshot, type PerformanceSnapshot } from '@/lib/performance-snapshot';

const snap = (loadedAt: number): PerformanceSnapshot => ({
  indexData: { period: { start: '', end: '' } } as unknown as PerformanceSnapshot['indexData'],
  hourlyData: null,
  savingsDays: null,
  govSavings: null,
  govCounts: null,
  byAgent: null,
  auditFailed: false,
  loadedAt,
});

beforeEach(() => clearSnapshots());

describe('performance snapshot', () => {
  it('keeps each fleet and range apart, and has nothing before a load', () => {
    expect(readSnapshot('f', 168)).toBeUndefined();
    expect(readSnapshot(null, 168)).toBeUndefined();
    saveSnapshot('f', 168, snap(1));
    saveSnapshot('f', 24, snap(2));
    saveSnapshot('g', 168, snap(3));
    expect(readSnapshot('f', 168)?.loadedAt).toBe(1);
    expect(readSnapshot('f', 24)?.loadedAt).toBe(2);
    expect(readSnapshot('g', 168)?.loadedAt).toBe(3);
    expect(readSnapshot('f', 72)).toBeUndefined();
  });

  it('takes later rule counts into a saved overview, and ignores them for an unsaved one', () => {
    saveSnapshot('f', 168, snap(1));
    const counts = { wouldBlocks: 4 } as unknown as PerformanceSnapshot['govCounts'];
    updateSnapshot('f', 168, { govCounts: counts });
    expect(readSnapshot('f', 168)).toMatchObject({ loadedAt: 1, govCounts: counts });
    updateSnapshot('f', 24, { govCounts: counts });
    expect(readSnapshot('f', 24)).toBeUndefined();
  });

  it('drops the oldest overview past twelve, and everything on sign-out', () => {
    for (let i = 0; i < 13; i++) saveSnapshot(`fleet-${i}`, 168, snap(i));
    expect(readSnapshot('fleet-0', 168)).toBeUndefined();
    expect(readSnapshot('fleet-12', 168)?.loadedAt).toBe(12);
    clearSnapshots();
    expect(readSnapshot('fleet-12', 168)).toBeUndefined();
  });
});
