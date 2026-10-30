import { notFound } from 'next/navigation';
import { SandboxV2Preview } from './preview';
import { SANDBOX_V2_STATES, type SandboxV2State } from './states';

// Sandbox v2 in the shell, with a stand-in session. Local development only: 404 in production.
// ?state= not-connected (default), just-connected, connected, rotated, openai, error, refused,
// step 3: rules-ready-made, rules-copy, rules-custom, rules-empty, rules-editing, rules-error,
// step 4: checks-ready, checks-waiting, checks-observe, checks-enforce, checks-pause, checks-stopped,
// checks-errors, checks-done, checks-report, checks-report-pass, checks-report-few, checks-error,
// and outside-window.
export const metadata = { title: 'Sandbox v2 preview' };

export default async function Page({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  if (process.env.NODE_ENV === 'production') notFound();
  const { state } = await searchParams;
  const known = (Object.keys(SANDBOX_V2_STATES) as SandboxV2State[]).find((s) => s === state) ?? 'not-connected';
  return <SandboxV2Preview state={known} />;
}
