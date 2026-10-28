'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { SkeletonCard } from '@whiteroom/ui';
import { PageHeader } from '@/components/citadel/PageChrome';
import { governanceList } from '@/lib/whiteroom/client';
import { sourceModel } from '@/lib/sandbox/practice/api';
import { defaultAgent, keepsConnectionTest, SAMPLE_AGENT } from '@/lib/sandbox/practice/model';
import { ROUTES } from '@/lib/routes';
import { TestRunFlow } from './TestRunFlow';
import s from './guided.module.css';

/**
 * Where /sandbox goes (§7 Redirect): the pre-flight, unless the fleet is one
 * it refuses (a Bedrock IAM role, or its own host or a cloud agent with no
 * Fleet key key to test with), which keeps the connection test. So does any
 * fleet whose agent can't be looked up (no session, practice tests off), and
 * /sandbox?connection=1, the way the pre-flight sends refused fleets here.
 */
export async function sandboxDestination(fleet: string): Promise<'practice' | 'connection'> {
  const gov = await governanceList(fleet);
  const agent = defaultAgent(gov.agents ?? [], gov.lastActiveAt) || SAMPLE_AGENT;
  return keepsConnectionTest(await sourceModel(fleet, agent)) ? 'connection' : 'practice';
}

export function SandboxEntry() {
  const router = useRouter();
  const [stay, setStay] = useState(false);
  useEffect(() => {
    let live = true;
    (async () => {
      if (new URLSearchParams(location.search).get('connection') === '1') return 'connection';
      const session = await fetch('/api/fleet/session', { credentials: 'same-origin', cache: 'no-store' }).then((r) => (r.ok ? r.json() : null));
      const fleet: string | undefined = session?.fleetId;
      return fleet ? sandboxDestination(fleet) : 'connection';
    })().then(
      (to) => { if (!live) return; if (to === 'practice') router.replace(ROUTES.practiceTest); else setStay(true); },
      () => { if (live) setStay(true); },
    );
    return () => { live = false; };
  }, [router]);
  if (stay) return <TestRunFlow />;
  return <>
    <PageHeader title="Sandbox" />
    <main className={s.content}><SkeletonCard label="Opening the Sandbox…" style={{ maxWidth: 480 }} /></main>
  </>;
}
