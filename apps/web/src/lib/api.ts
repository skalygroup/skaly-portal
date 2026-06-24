import { createClient } from '@/lib/supabase/client';

/**
 * Error thrown by {@link api} for any non-2xx response. Forms switch on `code`
 * (the stable machine string from the backend's error envelope) for inline
 * messaging; `status` and `message` are there for logging / fallbacks.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'ApiError';
  }
}

/**
 * Thin fetch wrapper for the Skaly API. Attaches the current Supabase access
 * token as a Bearer header, sets JSON content-type for non-FormData bodies, and
 * normalises the backend's `{ error: { code, message } }` envelope into an
 * {@link ApiError}. Returns the parsed JSON body on success.
 */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token;

  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      // Let the browser set the multipart boundary for FormData uploads.
      ...(init?.body && !(init.body instanceof FormData)
        ? { 'content-type': 'application/json' }
        : {}),
    },
    credentials: 'include',
  });

  if (!res.ok) {
    // Backend errors are `{ error: { code, message } }`; fall back gracefully if
    // the body is empty or not JSON (e.g. a proxy 502).
    const body = await res.json().catch(() => null);
    const err = body?.error ?? body ?? {};
    throw new ApiError(res.status, err.code ?? 'UNKNOWN', err.message);
  }

  // 204 No Content has an empty body — guard JSON parsing for void responses.
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
