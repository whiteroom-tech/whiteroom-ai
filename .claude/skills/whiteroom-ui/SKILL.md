---
name: whiteroom-ui
description: Enforce the shared @whiteroom/ui package for all dashboard UI. Use when creating, editing, or reviewing React/TSX in apps/dashboard (or any app that renders UI) — reuse existing @whiteroom/ui components and typography tokens before writing bespoke markup, and hoist new reusable presentational components into packages/ui instead of leaving them app-local.
---

# WhiteRoom shared UI (`@whiteroom/ui`)

All shared, presentational UI lives in the **`@whiteroom/ui`** workspace package
(`packages/ui`). `apps/dashboard` consumes it with
`import { X } from "@whiteroom/ui"` (linked via
`"@whiteroom/ui": "file:../../packages/ui"`, and listed in the dashboard's
`next.config` `transpilePackages` because the package ships raw `.ts`/`.tsx`
source). Components live in `packages/ui/src/*.tsx` and are re-exported from
`packages/ui/src/index.ts`.

Two rules, always applied when touching UI:

## 1. Reuse before you build

Before writing any markup, styling, or a shared token:

1. Read **`packages/ui/src/index.ts`** — it is the source of truth for what's
   available. Do not trust a hardcoded list; the package grows over time.
2. If a component or token covers the need, import it from `@whiteroom/ui`.
   **Never reimplement, copy/paste, or fork a primitive** that already exists.
3. If an existing component is close but not exact, **extend it with a prop**
   rather than creating a near-duplicate.

Current inventory (snapshot — always re-check `index.ts`):

- **Components:** `Logo`, `BrandLink`, `BannerMetric`, `StatBox`, `StatCard`,
  `CopyButton`, `CodeBlock`
- **Typography tokens (`theme.ts`):** `FONT_DISPLAY`, `FONT_MONO`

## 2. Hoist new reusable components

When you create UI that is presentational and reusable, put it in the package,
not the app.

**Hoist into `packages/ui`** if any of these hold:

- It's a generic primitive (logo, brand link, stat tile, metric, copy button,
  code block, badge…).
- It's already used in more than one place, or a second use is foreseeable.
- It carries shared visual styling / typography tokens.

**Keep it app-local** (do NOT hoist) if it's:

- A one-off layout specific to a single page/route.
- Tied to page business logic, data fetching, or route/app state.

### How to add a component to `@whiteroom/ui`

1. Create `packages/ui/src/<Name>.tsx`.
2. Match the conventions of its neighbors (`StatCard.tsx`, `CopyButton.tsx`):
   - Named `export function <Name>(...)` — **no default export**.
   - Props typed inline; **presentational only** (no data fetching or app state).
   - Add `'use client'` at the top only when the component is interactive
     (state, effects, event handlers — see `CopyButton`).
   - Style with the house pattern: Tailwind utility classes plus inline
     `style={{ ... }}` for exact colors, and the `font-display` / `font-mono`
     classes (or the `FONT_DISPLAY` / `FONT_MONO` tokens) for typography.
   - Add a short JSDoc describing when to use it.
3. Export it from `packages/ui/src/index.ts` (`export * from './<Name>';`).
4. In `apps/dashboard`, replace the inline version with
   `import { <Name> } from "@whiteroom/ui";` and delete the old copy.
5. Run `npm run typecheck` before finishing.

## When reviewing changes

- Flag any bespoke markup that duplicates an `@whiteroom/ui` primitive and
  replace it with the shared component.
- If a new shared-looking component was added under `apps/dashboard` instead of
  the package, hoist it per the steps above.
