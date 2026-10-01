import { notFound } from 'next/navigation';
import { SandboxPreview } from './preview';

// Sandbox's start step in the shell, with a stand-in session. Local development only: 404 in production.
export const metadata = { title: 'Sandbox preview' };

export default function Page() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <SandboxPreview />;
}
