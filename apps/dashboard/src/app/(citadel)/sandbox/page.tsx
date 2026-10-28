'use client';

import { Suspense } from 'react';
import { SandboxEntry } from '@/components/sandbox/SandboxEntry';

export default function SandboxPage() {
  // SandboxEntry reads the address (useSearchParams), so it renders on the client.
  return <Suspense><SandboxEntry /></Suspense>;
}
