import { createRequire } from 'node:module';

import { jsonSchemaTransform } from 'fastify-type-provider-zod';

import type { FastifyInstance } from 'fastify';

// Read the API version from package.json at runtime. A static
// `import '../package.json'` would sit outside tsconfig's `rootDir: "src"` and
// fail the build, so we resolve it via createRequire instead. This path
// (`../../package.json`) is correct from both the source tree (dev/tsx:
// src/lib → package.json) and the compiled output (dist/lib → package.json).
const require = createRequire(import.meta.url);
const { version } = require('../../package.json') as { version: string };

// Route areas → Swagger UI sections. Keeping this list in sync with the route
// barrels registered in app.ts gives grouped, described sections in the UI
// instead of everything landing under the single "default" tag.
const AREA_TAGS = [
  { name: 'auth', description: 'Invites, self-signup, session & MFA lifecycle' },
  { name: 'staff', description: 'Staff directory, profiles & MFA reset' },
  { name: 'clients', description: 'Client accounts' },
  { name: 'months', description: 'Monthly periods & lock state' },
  { name: 'settings', description: 'Admin settings & signup-request review' },
  { name: 'health', description: 'Liveness & dependency health' },
];
const KNOWN_TAGS = new Set(AREA_TAGS.map((t) => t.name));

/**
 * Derives the section tag from the route URL: the segment after the `/v1`
 * version prefix (e.g. `/v1/auth/invite` → `auth`, `/v1/health` → `health`).
 * Returns undefined for anything that isn't a known area so we never invent
 * stray tags.
 */
function tagForUrl(url: string): string | undefined {
  const seg = url.split('/').filter(Boolean)[1];
  return seg && KNOWN_TAGS.has(seg) ? seg : undefined;
}

/**
 * The Zod → OpenAPI transform, wrapped to stamp each route with its area tag.
 * We derive tags from the URL rather than hand-annotating every route schema,
 * and never clobber a tag a route set explicitly.
 */
const transform: typeof jsonSchemaTransform = (data) => {
  const result = jsonSchemaTransform(data);
  const tag = tagForUrl(result.url);
  if (tag) {
    const schema = (result.schema ?? {}) as { tags?: string[] };
    if (!schema.tags || schema.tags.length === 0) schema.tags = [tag];
    result.schema = schema;
  }
  return result;
};

/**
 * Registers Swagger (OpenAPI) + Swagger UI at `/docs`, derived automatically
 * from the Zod route schemas (audit M-12).
 *
 * The `nodeEnv` guard is passed in (rather than read from the env singleton)
 * so the production-gating behaviour is unit-testable without re-importing the
 * whole env/DB/Redis module graph. In production this is a no-op — `/docs` must
 * never be exposed there.
 *
 * MUST be called before the route plugins are registered so Swagger captures
 * their schemas.
 */
export async function registerSwagger(
  app: FastifyInstance,
  opts: { nodeEnv: string; port: number },
): Promise<void> {
  if (opts.nodeEnv === 'production') return;

  await app.register(import('@fastify/swagger'), {
    openapi: {
      info: { title: 'Skaly Business Portal API', version },
      servers: [{ url: `http://localhost:${opts.port}` }],
      tags: AREA_TAGS,
      components: {
        securitySchemes: {
          // Routes guarded by verifyJwt advertise `security: [{ bearerAuth: [] }]`
          // in their schema so Swagger UI shows the lock/auth icon. Enforcement
          // is the preHandler; this only documents the contract.
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
    },
    transform,
  });

  await app.register(import('@fastify/swagger-ui'), {
    routePrefix: '/docs',
  });
}