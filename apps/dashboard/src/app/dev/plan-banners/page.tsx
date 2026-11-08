import { notFound } from 'next/navigation';
import { PlanBannersPreview } from './preview';

// Every plan banner state, for the mockup-parity check. Nothing is read.
// Local development only: 404 in production.
export const metadata = { title: 'Plan banners preview' };

export default function Page() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <PlanBannersPreview />;
}
