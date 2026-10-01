import { AppShell } from '@/components/AppShell';

export default function CitadelLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
