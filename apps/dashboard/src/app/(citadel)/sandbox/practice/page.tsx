import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PracticeTest } from '@/components/sandbox/practice/PracticeTest';

export const metadata: Metadata = { title: 'Practice test' };

export default function PracticeTestPage() {
  // PracticeTest follows the address (useSearchParams), so it renders on the client.
  return <Suspense><PracticeTest /></Suspense>;
}
