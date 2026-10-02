import { AppShell } from '@/components/AppShell';
import { FleetAuthProvider } from '@/hooks/useFleetAuth';

export default function CitadelLayout({ children }: { children: React.ReactNode }) {
  return <FleetAuthProvider><AppShell>{children}</AppShell></FleetAuthProvider>;
}
