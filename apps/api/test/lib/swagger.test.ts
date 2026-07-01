import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { registerSwagger } from '../../src/lib/swagger.js';

/**
 * M-12: /docs is dev-only. Build a bare Fastify (no DB/Redis) with the Zod
 * compilers, register Swagger via the helper under each NODE_ENV, and assert
 * the gate. Keeps this security-relevant check fast and infra-free.
 */
function makeApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  return app;
}

describe('registerSwagger (M-12 dev-only gate)', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  it('serves /docs when NODE_ENV !== production', async () => {
    app = makeApp();
    await registerSwagger(app, { nodeEnv: 'development', port: 3001 });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/docs' });
    // swagger-ui redirects the bare prefix to /docs/, then serves the UI.
    expect(res.statusCode).not.toBe(404);
    expect([200, 302]).toContain(res.statusCode);
  });

  it('404s /docs when NODE_ENV === production', async () => {
    app = makeApp();
    await registerSwagger(app, { nodeEnv: 'production', port: 3001 });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/docs' });
    expect(res.statusCode).toBe(404);
  });

  it('stamps each route with its area tag derived from the URL', async () => {
    app = makeApp();
    await registerSwagger(app, { nodeEnv: 'development', port: 3001 });

    // Routes registered AFTER swagger, exactly as in app.ts. The transform
    // derives the tag from the URL segment after /v1.
    const r = app.withTypeProvider<ZodTypeProvider>();
    r.get('/v1/auth/whoami', { schema: { response: { 200: z.object({ ok: z.boolean() }) } } },
      async () => ({ ok: true }));
    r.get('/v1/settings/signup-requests', { schema: { response: { 200: z.array(z.string()) } } },
      async () => []);
    await app.ready();

    const spec = app.swagger() as {
      tags?: { name: string }[];
      paths: Record<string, Record<string, { tags?: string[] }>>;
    };

    expect(spec.paths['/v1/auth/whoami'].get.tags).toEqual(['auth']);
    expect(spec.paths['/v1/settings/signup-requests'].get.tags).toEqual(['settings']);
    // The area tag list is declared at the top level so the UI renders sections.
    expect(spec.tags?.map((t) => t.name)).toEqual(
      expect.arrayContaining(['auth', 'staff', 'clients', 'months', 'settings']),
    );
  });
});