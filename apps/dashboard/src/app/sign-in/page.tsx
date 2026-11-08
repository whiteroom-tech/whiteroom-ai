import { cookies } from 'next/headers';
import { auth } from '@/auth';
import { FREE_INVITE_COOKIE, verifyInviteCookie } from '@/lib/free-invite';
import { freePlanMode } from '@/lib/plans';
import { sandboxOpensAt } from '@/lib/sandbox-opens-at';
import { SignInView } from './sign-in-view';

/**
 * With FREE_PLAN off this renders exactly today's page and reads nothing.
 * Otherwise it works out whether a sign-up here would be Free (public, or
 * invite with a valid invite cookie from /sign-in?free=<code>) for the
 * subtitle, and, for a signed-in Free account made over the day's cap, when
 * its Sandbox opens (spec §3.8, S1).
 */
export default async function SignInPage() {
  const mode = freePlanMode();
  if (mode === 'off') return <SignInView />;
  const freeSignUp = mode === 'public' || verifyInviteCookie((await cookies()).get(FREE_INVITE_COOKIE)?.value);
  const userId = (await auth().catch(() => null))?.user?.id;
  const opensAt = userId ? await sandboxOpensAt(userId) : null;
  return <SignInView freeSignUp={freeSignUp} opensAt={opensAt?.toISOString() ?? null} />;
}
