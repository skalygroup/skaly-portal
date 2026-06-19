import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['**/*.test.{ts,tsx}'],
    // No web tests yet; don't fail CI until they exist (vitest 4 exits 1 on no tests).
    passWithNoTests: true,
  },
});
