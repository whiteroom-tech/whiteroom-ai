import { cookies } from 'next/headers';
import { FREE_INVITE_COOKIE, verifyInviteCookie } from '@/lib/free-invite';
import { freePlanMode } from '@/lib/plans';
import { SignInView } from './sign-in-view';

/**
 * With FREE_PLAN off this renders exactly today's page and reads nothing.
 * Otherwise it works out whether a sign-up here would be Free (public, or
 * invite with a valid invite cookie from /sign-in?free=<code>) for the
 * subtitle (spec §6), and lands every sign-in on / so a Free account,
 * new or returning, goes to Sandbox (app/page.tsx).
 */
export default async function SignInPage() {
  const mode = freePlanMode();
  if (mode === 'off') return <SignInView />;
  const freeSignUp = mode === 'public' || verifyInviteCookie((await cookies()).get(FREE_INVITE_COOKIE)?.value);
  return <SignInView freeSignUp={freeSignUp} landOnRoot />;
}
