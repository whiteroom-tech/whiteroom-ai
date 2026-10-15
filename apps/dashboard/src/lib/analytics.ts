'use client';

type PostHog = typeof import('posthog-js').default;

// posthog-js loads only once analytics starts, so it isn't in every page's bundle.
let loaded: Promise<PostHog> | null = null;
let currentId: string | null = null;

/**
 * Starts analytics for a signed-in user. PostHog keeps nothing in the browser
 * (persistence 'memory'), so without a starting ID every page load would get a
 * fresh anonymous one: events on most pages belong to nobody, and each
 * identify() merges another ID into the person until PostHog's limit. Starting
 * from the user's own ID keeps one ID per user and still stores nothing.
 */
export function initAnalytics(userId: string) {
  if (typeof window === 'undefined' || !userId) return;
  if (loaded) {
    // Another account signed in without a page load: start over as that user.
    if (userId !== currentId) {
      currentId = userId;
      void loaded.then((p) => { p.reset(); p.identify(userId); });
    }
    return;
  }
  currentId = userId;
  loaded = import('posthog-js').then(({ default: posthog }) => {
    posthog.init('phc_kkHTFEiVyW2Bto9QDvoBK5JB8aS62cwzYZBZNexerM9J', {
      api_host: 'https://us.i.posthog.com',
      defaults: '2025-05-24',
      // This application renders live credentials. Keep collection explicit,
      // and never record authentication/confirmation pages or their URL tokens.
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      disable_session_recording: true,
      persistence: 'memory',
      bootstrap: { distinctID: userId, isIdentifiedID: true },
      before_send: (event) => {
        if (window.location.pathname.startsWith('/auth/') ||
            window.location.pathname.startsWith('/settings/confirm-email') ||
            window.location.pathname === '/sign-in') return null;
        if (event?.properties) {
          event.properties = scrubAnalyticsProperties(event.properties);
        }
        return event;
      },
    });
    return posthog;
  });
  // A chunk that fails to load (offline, a deploy in between) leaves analytics
  // off for this page instead of an unhandled rejection; the next init retries.
  loaded.catch(() => { loaded = null; currentId = null; });
}

/** Events before initAnalytics are dropped, as posthog-js did before it was initialised. */
export const analytics = {
  capture(event: string, properties?: Record<string, unknown>) { void loaded?.then((p) => p.capture(event, properties)); },
  identify(id: string, properties?: Record<string, unknown>) { void loaded?.then((p) => p.identify(id, properties)); },
};

export function scrubAnalyticsProperties(properties: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(properties).flatMap(([key, value]) => {
    if (/token|password|secret|api.?key/i.test(key)) return [];
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        value = `${url.origin}${url.pathname}`;
      } catch {
        value = '[invalid URL]';
      }
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      value = scrubAnalyticsProperties(value as Record<string, unknown>);
    }
    return [[key, value]];
  }));
}
