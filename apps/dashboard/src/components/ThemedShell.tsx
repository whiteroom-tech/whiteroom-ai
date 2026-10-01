'use client';

// The .wr-shell root for pages outside the signed-in layouts (sign-in,
// onboarding, email confirmation). Theme tokens in globals.css are scoped to
// .wr-shell, so a page that isn't inside one gets no colors. It applies the
// stored theme the same way the signed-in layouts do; with none stored, it's
// dark.

import { useEffect, useRef } from 'react';
import { safeGet } from '@/lib/safe-storage';

export function ThemedShell({ children, className = '', style }: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const stored = safeGet('wr_theme');
    if (stored === 'light' || stored === 'dark') ref.current?.setAttribute('data-theme', stored);
  }, []);

  return (
    <div
      ref={ref}
      className={`wr-shell ${className}`.trim()}
      style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--tx)', ...style }}
    >
      {children}
    </div>
  );
}
