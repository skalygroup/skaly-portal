/**
 * The logging surface the three Sprint 12 jobs actually use.
 *
 * Structural, not pino's `Logger`, because these jobs are called from two places
 * with two different logger types: `app.log` (a `FastifyBaseLogger`) from the
 * internal cron routes, and the module `logger` (a pino `Logger`) from tests and
 * any in-process caller. The two are compatible in every way that matters here
 * and incompatible by nominal type, so the job asks for what it uses.
 */
export interface JobLogger {
  info: (obj: object, msg?: string) => void;
  /** Rollover's resume path: not an error (it recovered), but not routine either. */
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
}
