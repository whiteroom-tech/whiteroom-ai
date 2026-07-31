'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

export default function AuthCallback() {
  const router = useRouter();

  useEffect(() => {
    const supabase = createClient();
    let navigated = false;

    function go(path: string) {
      if (navigated) return;
      navigated = true;
      router.push(path);
    }

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (session?.user) {
        go('/dashboard');
      }
    });

    const url = new URL(window.location.href);
    const code = url.searchParams.get('code');

    if (code) {
      supabase.auth.exchangeCodeForSession(code).then(({ error }) => {
        if (error) {
          supabase.auth.getSession().then(({ data: { session } }) => {
            if (session?.user) go('/dashboard');
            else go('/sign-in');
          });
        }
      });
    } else if (!window.location.hash.includes('access_token')) {
      go('/sign-in');
    }

    return () => subscription.unsubscribe();
  }, [router]);

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: '#070B14' }}>
      <p className="text-sm font-mono" style={{ color: '#6B7C9E' }}>Signing in...</p>
    </div>
  );
}
