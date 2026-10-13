'use client';

import { AppShell } from '@/components/AppShell';
import { PracticeTest } from '@/components/sandbox/practice/PracticeTest';
import { PRACTICE_STATES, type PracticeState } from './states';

export function PracticePreviewPage({ state }: { state: PracticeState }) {
  return <AppShell><PracticeTest key={state} preview={PRACTICE_STATES[state]} /></AppShell>;
}
