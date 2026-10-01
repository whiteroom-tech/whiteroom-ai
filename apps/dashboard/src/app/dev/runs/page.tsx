import { notFound } from 'next/navigation';
import { RunsPreview } from './preview';

// Runs with sample data; nothing is fetched. Local development only: 404 in production.
export const metadata = { title: 'Runs preview' };

export default function Page() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <RunsPreview />;
}
