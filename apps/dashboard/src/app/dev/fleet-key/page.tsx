import { notFound } from 'next/navigation';
import { FleetKeyPreview } from './preview';

// Fleet key with sample data: nothing is provisioned, fetched or stored.
// Local development only: 404 in production.
export const metadata = { title: 'Fleet key preview' };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV === 'production') notFound();
  const { keys } = await searchParams;
  return <FleetKeyPreview withKeys={keys === '1'} />;
}
