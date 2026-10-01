import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Fleet key' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
