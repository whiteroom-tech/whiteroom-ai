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
import { ensureHomeFleet } from '@/lib/home-fleet';
import { SANDBOX_OPEN_FAILED, SANDBOX_OPENING, type HomeFleetResult } from '@/lib/home-fleet-shared';
import { safeGet, safeRemove, safeSet } from '@/lib/safe-storage';
import { SandboxClearedLine, SandboxOpensLaterLine } from './HomeFleetLines';
import { TestRunFlow } from './TestRunFlow';
import { SANDBOX_LEAD, SandboxHome } from './v2/SandboxHome';
import s from './guided.module.css';
import v from './v2/v2.module.css';

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
 * The new home fleet that replaced a retired one, until its Sandbox shows the
 * cleared line: the session re-check that follows can reload the page. Shown
 * only over that fleet's Sandbox, and dropped once any Sandbox opens.
 */
const CLEARED_KEY = 'wr_sandbox_cleared';

/** The Sandbox page while a Free account made over the day's sign-up cap waits (S15): the lead, then when it opens. */
export function SandboxOpensLater({ opensAt, now }: { opensAt: string; now?: number }) {
  return <>
    <PageHeader title="Sandbox" />
    <main className={s.content}>
      <div className={v.page}>
        <p className={v.lead2}>{SANDBOX_LEAD}</p>
        <SandboxOpensLaterLine opensAt={opensAt} now={now} />
      </div>
    </main>
  </>;
}

/**
 * /sandbox (Sandbox v2): the signed-in fleet's Sandbox, to connect a key and
 * point the agent at it. /sandbox?connection=1 keeps the older connection
 * test, as does a page with no fleet session. With an engine that has no
 * Sandbox v2 yet, it falls back to where /sandbox went before. A session check
 * that fails (502, network) says so with Try again: it isn't a missing session.
 *
 * A Free account's home fleet is made (or a retired one replaced) first, under
 * the same skeleton (free tier §4); paid accounts open as before.
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

  // The home fleet, before the Sandbox opens (not for ?connection=1).
  const [home, setHome] = useState<HomeFleetResult | null>(null);
  const [homeBusy, setHomeBusy] = useState(false);
  const [clearedFor, setClearedFor] = useState<string | null>(null);
  const { retry: recheckSession } = auth;
  const openHome = useCallback(() => {
    setHomeBusy(true);
    ensureHomeFleet().then(
      (result) => {
        if (!mounted.current) return;
        if (result.kind === 'ready' && result.cleared) { safeSet(CLEARED_KEY, result.fleetId); setClearedFor(result.fleetId); }
        setHome(result);
        setHomeBusy(false);
        // This browser's session now names the new fleet.
        if (result.kind === 'ready' && result.changed) recheckSession();
      },
      () => { if (mounted.current) { setHome({ kind: 'failed' }); setHomeBusy(false); } },
    );
  }, [recheckSession]);
  const homeStarted = useRef(false);
  useEffect(() => {
    if (connection || homeStarted.current) return;
    homeStarted.current = true;
    setClearedFor(safeGet(CLEARED_KEY));
    openHome();
  }, [connection, openHome]);

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

  // The cleared line shows once, over the new fleet's Sandbox; any Sandbox opening drops it from storage.
  const v2Fleet = home && shown.kind === 'v2' ? shown.fleet : null;
  const showsCleared = !!v2Fleet && v2Fleet === clearedFor;
  useEffect(() => { if (v2Fleet) safeRemove(CLEARED_KEY); }, [v2Fleet]);

  if (connection) return <TestRunFlow />;
  if (home?.kind === 'over_cap') return <SandboxOpensLater opensAt={home.opensAt} />;
  // A Free account's failure (or an unreachable server) stops the page; with the plan unknown it opens as before.
  const homeFailed = home?.kind === 'failed';
  if (home && !homeFailed && shown.kind === 'connection') return <TestRunFlow />;
  if (home && !homeFailed && shown.kind === 'v2') {
    return <SandboxHome fleet={shown.fleet} onUnavailable={fallBack} planLine={showsCleared ? <SandboxClearedLine /> : undefined} />;
  }
  return <>
    <PageHeader title="Sandbox" />
    <main className={s.content}>
      {homeFailed
        ? <div style={{ maxWidth: 480 }}><LoadFailed what="your Sandbox" text={SANDBOX_OPEN_FAILED} busy={homeBusy} onRetry={openHome} /></div>
        : home && shown.kind === 'failed'
          ? <div style={{ maxWidth: 480 }}><LoadFailed what="the Sandbox" onRetry={auth.retry} /></div>
          : <SkeletonCard label={SANDBOX_OPENING} style={{ maxWidth: 480 }} />}
    </main>
  </>;
}
