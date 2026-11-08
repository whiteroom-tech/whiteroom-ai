import { notFound } from 'next/navigation';
import { FleetKeyPreview } from './preview';
import { PlanPreview } from '../plan-banners/provider';

// Fleet key with sample data: nothing is provisioned, fetched or stored.
// Local development only: 404 in production.
export const metadata = { title: 'Fleet key preview' };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV === 'production') notFound();
  const { keys, plan } = await searchParams;
  // ?plan=free | suspended | live (app/dev/plan-banners/states.ts): the plan banner, the caveat, or "You're live".
  return <PlanPreview name={plan} fleetKey><FleetKeyPreview withKeys={keys === '1'} /></PlanPreview>;
}
