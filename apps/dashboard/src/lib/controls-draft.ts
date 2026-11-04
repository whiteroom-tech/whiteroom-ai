// A Controls rule edit that hasn't been saved, kept for this tab so leaving the
// page (Back, Forward, a reload) doesn't lose it: browser history can't be held
// back in the App Router, so the draft waits here instead. One per fleet, in
// sessionStorage (this tab only, gone when it closes). Cleared on every
// confirmed sign-out (session-local-state): a keyword rule's draft can hold
// customer terms.

import { safeSessionGet, safeSessionRemove, safeSessionSet } from '@/lib/safe-storage';
import type { RuleDraft } from '@/lib/controls-view';

const PREFIX = 'wr_controls_draft:';

export interface SavedDraft {
  ruleId: string;
  /** The rule's version the draft was made on: a rule changed since drops it. */
  version: number;
  draft: RuleDraft;
}

/**
 * The saved draft, or null when there's none or it isn't one this build can
 * open: sessionStorage outlives deploys in a tab, and anything that reads it is
 * untrusted, so a draft the editor couldn't render never reaches it.
 */
export function readDraft(fleetId: string): SavedDraft | null {
  const raw = safeSessionGet(PREFIX + fleetId);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<SavedDraft>;
    return typeof v.ruleId === 'string' && typeof v.version === 'number' && isRuleDraft(v.draft) ? (v as SavedDraft) : null;
  } catch {
    return null;
  }
}

/** The fields the rule editor reads, of the right kinds. */
function isRuleDraft(d: unknown): d is RuleDraft {
  if (!d || typeof d !== 'object') return false;
  const x = d as Record<string, unknown>;
  const isObject = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);
  return typeof x.ruleType === 'string' && typeof x.mode === 'string' && typeof x.response === 'string'
    && typeof x.alsoNotify === 'boolean' && typeof x.number === 'string' && isObject(x.params)
    && (x.appliesTo === 'all' || (Array.isArray(x.appliesTo) && x.appliesTo.every((a) => typeof a === 'string')));
}

export function writeDraft(fleetId: string, saved: SavedDraft): void {
  safeSessionSet(PREFIX + fleetId, JSON.stringify(saved));
}

export function removeDraft(fleetId: string): void {
  safeSessionRemove(PREFIX + fleetId);
}

/** Every fleet's draft in this tab (a sign-out). */
export function clearDrafts(): void {
  if (typeof window === 'undefined') return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const k = window.sessionStorage.key(i);
      if (k?.startsWith(PREFIX)) keys.push(k);
    }
    for (const k of keys) window.sessionStorage.removeItem(k);
  } catch {
    /* storage unavailable: nothing was kept */
  }
}
