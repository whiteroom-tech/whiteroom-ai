import type { Metadata } from 'next';
import { TEXT_SIZE_BOOT } from '@/lib/text-size';
import './globals.css';
import { AnalyticsInit } from './analytics-init';
import { Providers } from './providers';
import { headers } from 'next/headers';
import { auth } from '@/auth';
import { NONCE_HEADER } from '@/lib/csp';
import { savedTimeZone } from '@/lib/saved-zone';

export const metadata: Metadata = {
  title: { default: 'WhiteRoom', template: '%s · WhiteRoom' },
  description: 'Agent governance dashboard',
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon.ico', sizes: 'any' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180' }],
  },
};

const THEME_BOOT = "try{var t=localStorage.getItem('wr_theme');if(t==='light'||t==='dark'||t==='system')document.documentElement.setAttribute('data-wr-theme',t);"+TEXT_SIZE_BOOT+"}catch(e){}";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  const nonce = (await headers()).get(NONCE_HEADER) ?? undefined;
  const timeZone = await savedTimeZone(session?.user?.id);
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        {/* Before first paint: pin the stored theme and text size so no page
            flashes the other one while React hydrates (see globals.css). */}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@600;700&family=Inter:wght@400;500;600;700;900&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
      </head>
      <body className="bg-navy-950 text-navy-50 antialiased">
        <Providers session={session} timeZone={timeZone}>
          <AnalyticsInit />
          {children}
        </Providers>
      </body>
    </html>
  );
}
