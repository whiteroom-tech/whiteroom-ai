export const ALLOW: RegExp;
export function findColors(line: string, opts?: { css?: boolean }): string[];
export function canUpdate(old: Record<string, number> | null, counts: Record<string, number>): { ok: boolean; grew: [string, number][] };
export function compare(baseline: Record<string, number>, counts: Record<string, number>): { over: string[]; lowered: string[] };
