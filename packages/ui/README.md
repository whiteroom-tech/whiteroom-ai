# @whiteroom/ui

Shared presentational components and typography tokens for the dashboard
(`apps/dashboard`). Consumed via a local `file:` link, so it ships raw
`.ts`/`.tsx` source: the dashboard lists it in `transpilePackages`
(`next.config.ts`) and adds an `@source` directive in `src/app/globals.css` so
Tailwind scans these files for utility classes.

Only domain-agnostic pieces live here. App-specific composites that depend on
Supabase, the WhiteRoom client, or page state (e.g. `ByokCard`, the fleet
agent cards) stay in `apps/dashboard`.
