'use client';

import posthog from 'posthog-js';

let initialized = false;

export function initAnalytics() {
  if (initialized || typeof window === 'undefined') return;
  posthog.init('phc_kkHTFEiVyW2Bto9QDvoBK5JB8aS62cwzYZBZNexerM9J', {
    api_host: 'https://us.i.posthog.com',
    defaults: '2025-05-24',
  });
  initialized = true;
}

export { posthog };
