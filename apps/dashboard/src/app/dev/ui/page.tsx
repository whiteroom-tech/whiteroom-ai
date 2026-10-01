import { notFound } from 'next/navigation';
import { Gallery } from './gallery';

// Component gallery for the @whiteroom/ui primitives (redesign P0.3). Local
// development only: production builds return 404.
export const metadata = { title: 'UI primitives' };

export default function Page() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <Gallery />;
}
