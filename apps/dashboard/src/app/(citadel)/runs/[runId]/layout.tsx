import type { Metadata } from 'next';
import { agentIdFromSegment } from '@/lib/agent-detail';
import { parseRunId } from '@/lib/runs';

// "lead-agent · run 7 · WhiteRoom", like the page header. Absolute because
// the root's "%s · WhiteRoom" template doesn't reach through the Runs layout.
export async function generateMetadata({ params }: { params: Promise<{ runId: string }> }): Promise<Metadata> {
  const parsed = parseRunId(agentIdFromSegment((await params).runId));
  return { title: { absolute: `${parsed ? `${parsed.agentId} · run ${parsed.shift}` : 'Run'} · WhiteRoom` } };
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
