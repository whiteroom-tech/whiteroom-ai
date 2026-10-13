import { notFound } from 'next/navigation';
import { PracticePreviewPage } from './preview';
import { PRACTICE_STATES, type PracticeState } from './states';

// Sandbox › Practice test with sample data, one state per ?state= (default: setup).
// Local development only: 404 in production. The states are listed in states.ts.
export const metadata = { title: 'Practice test preview' };

export default async function Page({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  if (process.env.NODE_ENV === 'production') notFound();
  const { state } = await searchParams;
  const known = (Object.keys(PRACTICE_STATES) as PracticeState[]).find((s) => s === state) ?? 'setup';
  return <PracticePreviewPage state={known} />;
}
