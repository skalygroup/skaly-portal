import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // These are integration tests against ONE shared local Postgres. Running
    // test files in parallel lets one suite's fan-out (e.g. AuthService signup
    // notifies every active admin — src/services/AuthService.ts) reference
    // another suite's live admin fixture, so that suite's teardown DELETE hits
    // notifications_staff_id_fkey. Serialise file execution for deterministic
    // isolation; the suite is fast (~7s) so the wall-clock cost is negligible.
    fileParallelism: false,
  },
});
