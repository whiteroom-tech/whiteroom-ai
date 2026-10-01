import { notFound } from 'next/navigation';
import { AgentPreview } from './preview';

// Agent detail with sample data. Local development only: 404 in production.
export const metadata = { title: 'Agent preview' };

export default function Page() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <AgentPreview />;
}
