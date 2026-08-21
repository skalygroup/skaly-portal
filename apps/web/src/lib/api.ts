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
    /** The backend envelope's `error.details` (e.g. STALE_DATA carries
     * `{ currentVersion, updatedBy: { staffId, name } }` — 09-ERROR-HANDLING §5.1). */
    public readonly details?: Record<string, unknown>,
  ) {
    super(message ?? code);
    this.name = 'ApiError';
  }
}

/**
 * The authenticated fetch, returning the RAW `Response`.
 *
 * `api()` is this plus JSON parsing, and is what almost every caller wants. This
 * exists for the one response the app must not parse: the audit-log CSV export
 * (ADR-028) streams, and `res.json()` would pull the whole thing into the heap —
 * reintroducing on the client the ceiling the ADR removed on the server.
 *
 * The API authenticates on the `authorization` header only (auth.plugin.ts), so
 * a plain `<a href>` — which would let the browser stream the download straight
 * to disk with no JS involved — cannot reach it. That constraint is why the
 * export handler has to hold a Response at all.
 */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token;

  try {
    return await fetch(`${process.env.NEXT_PUBLIC_API_URL}${path}`, {
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
  } catch {
    // fetch() rejects only when no response ever arrived — API down, DNS gone,
    // offline, preflight refused. Every caller switches on ApiError, so letting
    // a bare TypeError through drops them all into their generic branch and the
    // user is told to retry a server that is not there. Give it a code instead.
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server.');
  }
}

/**
 * Thin fetch wrapper for the Skaly API. Attaches the current Supabase access
 * token as a Bearer header, sets JSON content-type for non-FormData bodies, and
 * normalises the backend's `{ error: { code, message } }` envelope into an
 * {@link ApiError}. Returns the parsed JSON body on success.
 */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);

  if (!res.ok) {
    // Backend errors are `{ error: { code, message } }`; fall back gracefully if
    // the body is empty or not JSON (e.g. a proxy 502).
    const body = await res.json().catch(() => null);
    const err = body?.error ?? body ?? {};
    throw new ApiError(res.status, err.code ?? 'UNKNOWN', err.message, err.details);
  }

  // 204 No Content has an empty body — guard JSON parsing for void responses.
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
