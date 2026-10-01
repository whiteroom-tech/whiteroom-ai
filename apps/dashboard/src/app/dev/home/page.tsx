import { notFound } from 'next/navigation';
import { HomePreview } from './preview';

// Home with sample data, to check the populated layout without a fleet.
// Local development only: production builds return 404.
export const metadata = { title: 'Home preview' };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV === 'production') notFound();
  const { empty } = await searchParams;
  return <HomePreview empty={empty === '1'} />;
}
