import { notFound } from 'next/navigation';
import { SandboxPreview } from './preview';

// Sandbox in the shell, with a stand-in session. Local development only: 404 in production.
// ?state=failed shows a live test whose agent's calls the provider refused.
export const metadata = { title: 'Sandbox preview' };

export default async function Page({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  if (process.env.NODE_ENV === 'production') notFound();
  const { state } = await searchParams;
  return <SandboxPreview state={state === 'failed' ? 'failed' : undefined} />;
}
