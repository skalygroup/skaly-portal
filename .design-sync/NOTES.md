# design-sync notes — Skaly Portal Code Components

Target project: **Skaly Portal — Code Components**
(`https://claude.ai/design/p/9d27f4b4-22e3-48ae-93cf-cca25f01d284`).
This is SEPARATE from the hand-built "Skaly Portal Design System" project
(`a5ef85e9-...`) — never sync this repo into that one; it has 16+ hand-authored
components + full screen mockups this repo can't reproduce.

## Shape / why it's unusual
- The "design system" is 6 shadcn/Radix + Tailwind v4 primitives living INSIDE
  the Next.js app (`apps/web/src/components/ui` + `auth/brand-panel`), not a
  published package with a `dist/`. So this is **synth-entry / no-dist** mode.
- We do NOT let synth-entry `export *` the whole app. A hand-written entry
  (`apps/web/.ds-build/entry.tsx`, committed) re-exports only the 6 scoped
  components. The converter is pointed at it via `--entry`, which also makes
  `PKG_DIR` resolve to `apps/web`.

## Build scaffolding (committed, under apps/web/.ds-build/)
- `entry.tsx` — the bundle entry (6 components).
- `tsconfig.json` — read by the converter's tsconfigPathsPlugin. Maps `@/*` →
  `../src/*` and aliases `next/image`/`next/link` to local shims.
  **Must be plain JSON with NO `//` or `"//"` comment keys** — the plugin's
  comment stripper mangles `//`, the JSON fails to parse, and the plugin
  silently disables (then `next/image`'s real impl bundles and throws
  `process is not defined` at runtime). This cost a debug cycle.
- `shims/next-image.tsx`, `shims/next-link.tsx` — render plain `<img>`/`<a>` so
  components bundle outside Next. The image shim also inlines known `public/`
  assets by absolute URL (currently `/brand/skaly-logo.png`) as a data URI,
  because those paths 404 in the preview/design environment — this is what makes
  BrandPanel's logo show.
- `tw-input.css` + `compile-css.mjs` → `styles.compiled.css` (gitignored).
  The app's CSS is Tailwind v4 (`@import 'tailwindcss'` + `@theme` + `@apply`),
  which MUST be compiled to a static stylesheet (`cfg.cssEntry`). compile-css
  uses the app's own `@tailwindcss/postcss` (resolved out of the pnpm `.pnpm`
  store via createRequire, since postcss isn't hoisted). **Re-run compile-css
  before every build** (the driver does NOT run it — it only copies the
  already-compiled file).

## Theme decision (important for previews + the conventions header)
- The portal is dark-only, but the app applies NO `.dark` class; shadcn tokens
  sit at light `:root`. The `ui/` primitives are generic scaffolding — the real
  login/auth UI hand-rolls controls with the Skaly brand tokens + gold accent
  and does NOT use these primitives yet.
- Previews therefore wrap components in `<div className="dark" …>` on a dark
  brand surface so the dark shadcn palette applies — that's how they'd look in
  the portal. The conventions header tells the design agent to do the same.

## Fonts
- Big Shoulders / DM Sans / DM Mono are served by next/font at runtime in-app.
  `cfg.runtimeFontPrefixes` suppresses [FONT_MISSING]; tw-input.css ALSO adds a
  Google Fonts `@import` + `--font-*` var defs so previews render in the real
  fonts. `[FONT_REMOTE] "Arial Narrow"` is just a named fallback — non-blocking.

## CSS coverage
- Shipped `styles.css` is STATIC (not JIT). We scan all of `../src` and safelist
  the full brand colour families via `@source inline(...)` so the design agent
  can compose with brand utilities the app doesn't yet use. If the agent needs
  utilities outside that set, widen the scan/safelist and rebuild.

## Known render warns (all triaged clean)
- `[FONT_REMOTE] "Arial Narrow"` — expected (fallback in the display font stack).

## Focus-ring rule (globals.css + tw-input.css)
- The gold `*:focus-visible` outline MUST live in `@layer base` (not unlayered).
  Unlayered, it beats `focus-visible:outline-none` utilities (layer precedence >
  specificity) and doubles up the ring on controls that manage their own focus
  (e.g. the auth input wrappers). Both globals.css and the mirrored tw-input.css
  carry the `@layer base` version — keep them in sync.

## Re-sync risks (watch-list)
- **Playwright**: render check needs `playwright` importable from `.ds-sync`.
  We junctioned `.ds-sync/node_modules/playwright` → the pnpm store copy
  (`playwright@1.61.1`, pins chromium-1228, which is cached). The junction is
  gitignored — recreate it on a fresh clone (PowerShell `New-Item -ItemType
  Junction`). If the repo bumps Playwright, the cached chromium build may no
  longer match.
- **Network**: `npm i @tailwindcss/cli` failed (flaky network) — that's why
  compile-css resolves the app's own postcss/tailwind instead. Don't depend on
  fresh installs.
- **next/image shim asset map**: if BrandPanel (or new components) reference
  more `public/` assets by absolute URL, add them to `PUBLIC_ASSETS` in the
  shim or they'll 404 in previews.
- **Source drift**: if the `ui/` components gain props/variants, re-run
  compile-css → driver; check the conventions header's class list still
  validates against the fresh build.
- **If these primitives start being used on light surfaces** (a `.dark` toggle
  is added, or a light theme appears), revisit the dark-wrapper preview choice.
