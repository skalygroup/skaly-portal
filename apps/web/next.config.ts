import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';

import type { NextConfig } from 'next';

const r2PublicUrl = process.env.NEXT_PUBLIC_R2_PUBLIC_URL;
const r2Hostname = r2PublicUrl ? new URL(r2PublicUrl).hostname : null;

/**
 * Config is a phase function so the `@skaly/shared` dev-HMR workaround applies
 * ONLY under `next dev` (PHASE_DEVELOPMENT_SERVER), never in the prod/Vercel
 * build.
 *
 * Why the workaround: @skaly/shared is a symlinked, pre-built CommonJS workspace
 * package. Under `next dev`, Next resolves the symlink to its real path (outside
 * node_modules), treats the compiled CJS as first-party source, and injects the
 * Fast Refresh footer `import.meta.webpackHot.accept()` — which a CommonJS module
 * can't parse ("Cannot use import.meta outside a module"). That breaks every dev
 * route bundling a shared schema (e.g. /login). Keeping the node_modules path
 * (`resolve.symlinks = false`) + `transpilePackages` routes it through Next's
 * transform correctly and fixes it.
 *
 * Why it's dev-only: `resolve.symlinks = false` leaves a symlinked directory in
 * the output, which Vercel's serverless packager rejects ("files in symlinked
 * directories"). The prod build consumes @skaly/shared as a normal CJS
 * dependency — no hack needed (see commit acf9f6f).
 */
/**
 * Security headers live in `vercel.json`, not here. That file is strict JSON and
 * Vercel's schema rejects unknown keys — a `$comment` array in it failed every
 * deployment with "should NOT have additional property `$comment`" before the
 * build even started, so the reasoning behind the CSP lives here instead.
 *
 * CSP is ENFORCING as of Sprint 13 (audit H-08). It shipped Report-Only, which
 * reports to nobody — there is no report-uri and never was, so Report-Only was a
 * header that did precisely nothing. Enforcing it is the whole point of the item.
 *
 * script-src keeps 'unsafe-inline' and that is a real hole, named rather than
 * hidden: the App Router inlines its hydration payload (self.__next_f.push) into
 * every document, so the alternatives are a per-request nonce from middleware —
 * which opts every page out of static rendering — or this. What makes it an
 * acceptable one HERE is that the app has no dangerouslySetInnerHTML anywhere
 * (asserted by a repo grep in STEP 8) and renders every user string as a text
 * node, so there is no injection point for the directive to backstop.
 * ponytail: 'unsafe-inline' on script-src; move to a middleware nonce if any page
 * ever renders user-controlled markup.
 *
 * 'unsafe-eval' is GONE. Next needs it for the dev overlay's source mapping, never
 * in a production build, and it is the directive that turns an XSS into arbitrary
 * code.
 *
 * connect-src must carry the API over BOTH https and wss — the socket is a separate
 * origin scheme and omitting wss: breaks every real-time surface silently, which is
 * the classic way a CSP "passes" review and breaks the app after deploy.
 *
 * Vercel Web Analytics needs no CSP entry: its script (/_vercel/insights/script.js)
 * and beacon (/_vercel/insights/view) are both same-origin.
 */
export default (phase: string): NextConfig => {
  const isDev = phase === PHASE_DEVELOPMENT_SERVER;

  return {
    reactStrictMode: true,
    ...(isDev
      ? {
          transpilePackages: ['@skaly/shared'],
          webpack: (webpackConfig: { resolve: { symlinks?: boolean } }) => {
            // Keep the node_modules symlink path so Next doesn't treat the
            // compiled CJS as first-party and inject an unparseable HMR footer.
            webpackConfig.resolve.symlinks = false;
            return webpackConfig;
          },
        }
      : {}),
    images: {
      remotePatterns: [
        // R2 presigned URL host — added automatically when NEXT_PUBLIC_R2_PUBLIC_URL is set
        ...(r2Hostname ? [{ protocol: 'https' as const, hostname: r2Hostname }] : []),
      ],
    },
    experimental: {
      // `forbidden()` + app/forbidden.tsx. Auth-Matrix §3 requires a real HTTP
      // 403 on direct URL access to a panel the role may not see, not a
      // redirect — and a page that merely RENDERS "403" still answers 200.
      // This is the platform's own answer to that; the alternative was a
      // middleware branch per panel, which is a second copy of the panel list.
      authInterrupts: true,
    },
  };
};
