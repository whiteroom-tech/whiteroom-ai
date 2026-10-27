import { describe, expect, it } from 'vitest';
import { coverageLine } from '@/components/settings/AuditIntegritySection';

describe('audit check coverage', () => {
  it('states how much was checked, and says "All" only at the newest event', () => {
    expect(coverageLine(939, 2045, '15 days ago')).toBe('939 of 2,045 events checked (45%) · 15 days ago');
    expect(coverageLine(2044, 2045, 'just now')).toBe('2,044 of 2,045 events checked (99%) · just now');
    expect(coverageLine(2045, 2045, 'just now')).toBe('All 2,045 events checked · just now');
    expect(coverageLine(0, 2045, null)).toBe('Not checked yet');
    expect(coverageLine(5, 10, null)).toBe('Not checked yet');
  });
});
