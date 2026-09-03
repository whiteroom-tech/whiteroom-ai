import type { Metadata } from 'next';
import './globals.css';
import { AnalyticsInit } from './analytics-init';
import { Providers } from './providers';
import { auth } from '@/auth';

export const metadata: Metadata = {
  title: 'WhiteRoom Dashboard',
  description: 'Agent governance dashboard',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  return (
    <html lang="en" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@600;700&family=Inter:wght@400;500;600;700;900&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
      </head>
      <body className="bg-navy-950 text-navy-50 antialiased">
        <Providers session={session}>
          <AnalyticsInit />
          {children}
        </Providers>
      </body>
    </html>
  );
}
