import { z } from 'zod';
import 'dotenv/config';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'staging', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3001),
  TZ: z.string().default('Asia/Kolkata'),

  // Comma-separated allowlist of browser origins for CORS + Socket.io.
  // Parsed into a trimmed string[]. Default covers local dev + prod web.
  CORS_ALLOWED_ORIGINS: z
    .string()
    .default('http://localhost:3000,https://portal.skaly.in')
    .transform((s) => s.split(',').map((o) => o.trim()).filter(Boolean)),

  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MIN: z.coerce.number().default(2),
  DATABASE_POOL_MAX: z.coerce.number().default(20),

  REDIS_URL: z.string(),

  SUPABASE_URL: z.string().url(),
  SUPABASE_JWT_SECRET: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // Anthropic — deferred until Sprint 8. Optional now; required
  // before any bot route is exercised.
  ANTHROPIC_API_KEY: z.string().startsWith('sk-ant-').optional(),
  ANTHROPIC_MODEL_PROD: z.string().default('claude-sonnet-4-6'),
  ANTHROPIC_MODEL_DEV: z.string().default('claude-haiku-4-5-20251001'),

  // R2 — deferred until Sprint 1 (CV upload). Optional now;
  // required before any file upload path is exercised.
  R2_ENDPOINT: z.string().url().optional(),
  R2_ACCESS_KEY_ID: z.string().min(1).optional(),
  R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  R2_BUCKET_NAME: z.string().min(1).optional(),

  CRON_SECRET: z.string().min(32, 'CRON_SECRET must be at least 32 chars'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export const env = EnvSchema.parse(process.env);
export type Env = z.infer<typeof EnvSchema>;

/**
 * Helper: throws at call site if a deferred service is needed
 * but its credentials are missing. Use in services that depend
 * on R2 or Anthropic.
 */
export function requireR2(): {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
} {
  if (
    !env.R2_ENDPOINT ||
    !env.R2_ACCESS_KEY_ID ||
    !env.R2_SECRET_ACCESS_KEY ||
    !env.R2_BUCKET_NAME
  ) {
    throw new Error(
      'R2 not configured. Set R2_ENDPOINT, R2_ACCESS_KEY_ID, ' +
      'R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME in env.',
    );
  }
  return {
    endpoint: env.R2_ENDPOINT,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucketName: env.R2_BUCKET_NAME,
  };
}

export function requireAnthropicKey(): string {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY not configured. Set it in env before ' +
      'invoking bot routes.',
    );
  }
  return env.ANTHROPIC_API_KEY;
}
