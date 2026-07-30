import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Mirror the tsconfig "@/*" path alias so tests can import app modules.
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test-setup.ts'],
    include: ['**/*.test.{ts,tsx}'],
    // No web tests yet; don't fail CI until they exist (vitest 4 exits 1 on no tests).
    passWithNoTests: true,
  },
});
