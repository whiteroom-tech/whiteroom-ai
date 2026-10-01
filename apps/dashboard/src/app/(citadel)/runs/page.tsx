'use client';

import { RunsTable } from '@/components/runs/RunsTable';

// README › Screens › 2a. RunsTable falls back to the event feed while the
// engine has no list_runs.
export default function RunsPage() {
  return <RunsTable />;
}
