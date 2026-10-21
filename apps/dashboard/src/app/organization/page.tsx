import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { getMyOrganization } from '@/lib/organizations';
import { OrganizationView } from './organization-view';

export const metadata: Metadata = { title: 'Organization' };

// Scoped to the caller's membership and role on every request.
export const dynamic = 'force-dynamic';

function requestHost(h: Headers): string {
  return (h.get('x-forwarded-host') || h.get('host') || '').toLowerCase().replace(/:\d+$/, '');
}

export default async function OrganizationPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/sign-in?callbackUrl=%2Forganization');

  const expected = process.env.CONSOLE_HOST?.toLowerCase().trim().replace(/:\d+$/, '');
  const consoleMode = Boolean(expected) && requestHost(await headers()) === expected;

  const mine = await getMyOrganization();
  return <OrganizationView mine={mine} viewerId={session.user.id} consoleMode={consoleMode} />;
}
