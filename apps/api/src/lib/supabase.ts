import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from './env.js';

/**
 * Supabase Admin client — built with the SERVICE ROLE key. Backend-only:
 * this key bypasses Row Level Security, so it must never reach the browser.
 *
 * No session persistence / token auto-refresh: this is a stateless server
 * actor used for user provisioning (createUser, inviteUserByEmail) and MFA
 * administration, not a logged-in user.
 */
export const supabaseAdmin: SupabaseClient = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);
