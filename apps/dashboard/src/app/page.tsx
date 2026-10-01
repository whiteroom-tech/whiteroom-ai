import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { ROUTES } from '@/lib/routes';

export default async function Home() {
  const session = await auth();
  redirect(session ? ROUTES.fleetKey : '/sign-in');
}
