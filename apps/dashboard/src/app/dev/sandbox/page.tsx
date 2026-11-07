import { notFound } from 'next/navigation';
import { type PreviewState, SandboxPreview } from './preview';

// Sandbox in the shell, with a stand-in session. Local development only: 404 in production.
// ?state= shows a sample test: failed (the provider refused the agent's calls),
// passed (a live test with every check passed), waiting (no calls yet),
// idle (no calls after two minutes: "Nothing happening?" opens) or empty (no past tests).
export const metadata = { title: 'Sandbox preview' };

// Listed here, not read from preview.tsx: a client module's values aren't readable on the server.
const STATES: readonly PreviewState[] = ['failed', 'passed', 'waiting', 'idle', 'empty'];

export default async function Page({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  if (process.env.NODE_ENV === 'production') notFound();
  const { state } = await searchParams;
  const known = STATES.find((s) => s === state);
  return <SandboxPreview state={known} />;
}
