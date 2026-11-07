import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { ControlsPreview } from './preview';

// Controls with sample rules, answered by an in-memory engine in the browser:
// add, edit, save and remove all work, nothing leaves the page. Local
// development only: production builds return 404.
export const metadata = { title: 'Controls preview' };

export default function Page() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <Suspense><ControlsPreview /></Suspense>;
}
