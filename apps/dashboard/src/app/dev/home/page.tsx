import { notFound } from 'next/navigation';
import { HomePreview } from './preview';
import { PlanPreview } from '../plan-banners/provider';

// Home with sample data, to check the populated layout without a fleet.
// Local development only: production builds return 404.
export const metadata = { title: 'Home preview' };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV === 'production') notFound();
  const { empty, busy, view, plan } = await searchParams;
  // ?plan=free (etc., app/dev/plan-banners/states.ts): that plan banner, and Home's connect-line caveat.
  return <PlanPreview name={plan}><HomePreview empty={empty === '1'} busy={busy === '1'} view={view === 'table' ? 'table' : 'cards'} /></PlanPreview>;
}
