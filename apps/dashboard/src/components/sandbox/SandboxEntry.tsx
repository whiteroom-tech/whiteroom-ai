'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { SkeletonCard } from '@whiteroom/ui';
import { PageHeader } from '@/components/citadel/PageChrome';
import { governanceList } from '@/lib/whiteroom/client';
import { sourceModel } from '@/lib/sandbox/practice/api';
import { defaultAgent, keepsConnectionTest, SAMPLE_AGENT } from '@/lib/sandbox/practice/model';
import { ROUTES } from '@/lib/routes';
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

type Shown = { kind: 'deciding' } | { kind: 'v2'; fleet: string } | { kind: 'connection' };

/**
 * /sandbox (Sandbox v2): the signed-in fleet's Sandbox, to connect a key and
 * point the agent at it. /sandbox?connection=1 keeps the older connection
 * test, as does a page with no fleet session. With an engine that has no
 * Sandbox v2 yet, it falls back to where /sandbox went before.
 */
export function SandboxEntry() {
  const router = useRouter();
  // From the address, so a link that only changes the query decides again.
  const connection = useSearchParams()?.get('connection') === '1';
  const [shown, setShown] = useState<Shown>({ kind: 'deciding' });
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    let live = true;
    if (connection) return;
    setShown({ kind: 'deciding' });
    fetch('/api/fleet/session', { credentials: 'same-origin', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (session: { fleetId?: unknown } | null) => {
          if (!live) return;
          const fleet = typeof session?.fleetId === 'string' && session.fleetId ? session.fleetId : null;
          setShown(fleet ? { kind: 'v2', fleet } : { kind: 'connection' });
        },
        () => { if (live) setShown({ kind: 'connection' }); },
      );
    return () => { live = false; };
  }, [connection]);

  const fleet = shown.kind === 'v2' ? shown.fleet : null;
  const fallBack = useCallback(() => {
    if (!fleet) return;
    setShown({ kind: 'deciding' });
    sandboxDestination(fleet).then(
      (to) => { if (!mounted.current) return; if (to === 'practice') router.replace(ROUTES.practiceTest); else setShown({ kind: 'connection' }); },
      () => { if (mounted.current) setShown({ kind: 'connection' }); },
    );
  }, [fleet, router]);

  if (connection || shown.kind === 'connection') return <TestRunFlow />;
  if (shown.kind === 'v2') return <SandboxHome fleet={shown.fleet} onUnavailable={fallBack} />;
  return <>
    <PageHeader title="Sandbox" />
    <main className={s.content}><SkeletonCard label="Opening the Sandbox…" style={{ maxWidth: 480 }} /></main>
  </>;
}
