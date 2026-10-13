import type { Metadata } from 'next';
import { PracticeTest } from '@/components/sandbox/practice/PracticeTest';

export const metadata: Metadata = { title: 'Practice test' };

export default function PracticeTestPage() {
  return <PracticeTest />;
}
