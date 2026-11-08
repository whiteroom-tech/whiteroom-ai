import { notFound } from 'next/navigation';
import { SandboxOpenPreview } from './preview';
import { SANDBOX_OPEN_STATES, type SandboxOpenState } from './states';

// Opening a Free account's Sandbox (free tier §3.8, S14–S17) in the shell. Local development only: 404 in production.
// ?state= opening (default), opens-later, opens-tomorrow, failed, cleared.
export const metadata = { title: 'Sandbox open preview' };

export default async function Page({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  if (process.env.NODE_ENV === 'production') notFound();
  const { state } = await searchParams;
  const known = SANDBOX_OPEN_STATES.find((s) => s === state) ?? 'opening';
  return <SandboxOpenPreview state={known as SandboxOpenState} />;
}
