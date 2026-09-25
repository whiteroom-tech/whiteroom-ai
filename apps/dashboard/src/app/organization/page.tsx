import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { getMyOrganization } from '@/lib/organizations';
import { OrganizationView } from './organization-view';

// Scoped to the caller's membership and role on every request.
export const dynamic = 'force-dynamic';

export default async function OrganizationPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/sign-in?callbackUrl=%2Forganization');

  const mine = await getMyOrganization();
  return <OrganizationView mine={mine} viewerId={session.user.id} />;
}
