import { notFound } from 'next/navigation';
import { PerformancePreview } from './preview';

// Performance's Savings and By agent panels with sample data. Local development only: 404 in production.
export const metadata = { title: 'Performance preview' };

export default function Page() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <PerformancePreview />;
}
