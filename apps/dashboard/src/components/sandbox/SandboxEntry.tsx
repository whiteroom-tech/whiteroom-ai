'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { SkeletonCard } from '@whiteroom/ui';
import { PageHeader } from '@/components/citadel/PageChrome';
import { LoadFailed } from '@/components/citadel/States';
import { governanceList } from '@/lib/whiteroom/client';
import { sourceModel } from '@/lib/sandbox/practice/api';
import { defaultAgent, keepsConnectionTest, SAMPLE_AGENT } from '@/lib/sandbox/practice/model';
import { ROUTES } from '@/lib/routes';
import { useFleetAuth } from '@/hooks/useFleetAuth';
import { TestRunFlow } from './TestRunFlow';
import { SandboxHome } from './v2/SandboxHome';
import s from './guided.module.css';

/**
 * Where /sandbox went before Sandbox v2 (§7 Redirect), and still goes when the
 * engine has no Sandbox v2: the pre-flight, unless the fleet is one it refuses
 * (a Bedrock IAM role, or its own host or a cloud agent with no Fleet key key
 * to test with), which keeps the connection test. So does any fleet whose
 * agent can't be looked up (no session, practice tests off).
 */
export async function sandboxDestination(fleet: string): Promise<'practice' | 'connection'> {
  const gov = await governanceList(fleet);
  const agent = defaultAgent(gov.agents ?? [], gov.lastActiveAt) || SAMPLE_AGENT;
  return keepsConnectionTest(await sourceModel(fleet, agent)) ? 'connection' : 'practice';
}

type Shown = { kind: 'deciding' } | { kind: 'v2'; fleet: string } | { kind: 'connection' } | { kind: 'failed' };

/**
 * /sandbox (Sandbox v2): the signed-in fleet's Sandbox, to connect a key and
 * point the agent at it. /sandbox?connection=1 keeps the older connection
 * test, as does a page with no fleet session. With an engine that has no
 * Sandbox v2 yet, it falls back to where /sandbox went before. A session check
 * that fails (502, network) says so with Try again: it isn't a missing session.
 */
export function SandboxEntry() {
  const router = useRouter();
  // From the address, so a link that only changes the query decides again.
  const connection = useSearchParams()?.get('connection') === '1';
  // The page's one session check (FleetAuthProvider in the (citadel) layout); ?connection=1 needs none.
  const auth = useFleetAuth({ idle: connection });
  // Set by the fallback below: where the page went once the Sandbox v2 wasn't there.
  const [fellBack, setFellBack] = useState<{ fleet: string; to: 'deciding' | 'connection' } | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  // 401 is the one answer meaning "no fleet session"; a check that failed (502, network) offers Try again.
  const session: Shown = auth.status === 'checking'
    ? { kind: 'deciding' }
    : auth.status === 'authenticated'
      ? (auth.fleetId ? { kind: 'v2', fleet: auth.fleetId } : { kind: 'connection' })
      : auth.retryableError ? { kind: 'failed' } : { kind: 'connection' };
  const shown: Shown = session.kind === 'v2' && fellBack?.fleet === session.fleet
    ? { kind: fellBack.to }
    : session;

  const fleet = shown.kind === 'v2' ? shown.fleet : null;
  const fallBack = useCallback(() => {
    if (!fleet) return;
    setFellBack({ fleet, to: 'deciding' });
    sandboxDestination(fleet).then(
      (to) => { if (!mounted.current) return; if (to === 'practice') router.replace(ROUTES.practiceTest); else setFellBack({ fleet, to: 'connection' }); },
      () => { if (mounted.current) setFellBack({ fleet, to: 'connection' }); },
    );
  }, [fleet, router]);

  if (connection || shown.kind === 'connection') return <TestRunFlow />;
  if (shown.kind === 'v2') return <SandboxHome fleet={shown.fleet} onUnavailable={fallBack} />;
  return <>
    <PageHeader title="Sandbox" />
    <main className={s.content}>
      {shown.kind === 'failed'
        ? <div style={{ maxWidth: 480 }}><LoadFailed what="the Sandbox" onRetry={auth.retry} /></div>
        : <SkeletonCard label="Opening the Sandbox…" style={{ maxWidth: 480 }} />}
    </main>
  </>;
}
