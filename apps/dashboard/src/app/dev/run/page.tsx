import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { RunPreview } from './preview';

// Run detail with sample data; nothing is fetched. Local development only: 404 in production.
export const metadata = { title: 'Run preview' };

export default function Page() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <Suspense><RunPreview /></Suspense>;
}
