/**
 * Copy src/assets into dist after `tsc`.
 *
 * `tsc` emits only what it compiles, so the vendored report fonts (five .ttf
 * files) never reach dist. `Font.register` resolves them relative to
 * `import.meta.url`, which in production is `dist/workers/report-document.js` —
 * so without this the FIRST report generated on Railway fails with ENOENT, and
 * only there: local dev runs from src and looks perfectly fine.
 *
 * A build step rather than a bundler config because the build is a plain `tsc`
 * (see tsconfig.build.json's note on why it stays that way).
 */
import { cp, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'src', 'assets');
const to = join(root, 'dist', 'assets');

await cp(from, to, { recursive: true });

// Fail the build rather than ship a binary that cannot render a report. Silent
// success here would surface as a runtime ENOENT in production, which is the
// worst place to learn about a missing file.
for (const f of [
  'BigShoulders-Bold.ttf',
  'DMSans-Regular.ttf',
  'DMSans-Medium.ttf',
  'DMSans-SemiBold.ttf',
  'DMMono-Regular.ttf',
]) {
  await access(join(to, 'fonts', f)).catch(() => {
    throw new Error(`copy-assets: ${f} is missing from dist/assets/fonts — see src/assets/fonts/README.md`);
  });
}

console.log(`[copy-assets] src/assets -> dist/assets`);
