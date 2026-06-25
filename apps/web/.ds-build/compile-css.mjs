// Compile the Tailwind v4 input (tw-input.css) into a static stylesheet
// (styles.compiled.css) using the SAME @tailwindcss/postcss plugin the Next
// app uses — so the bundle's CSS matches production utilities. Output is
// gitignored and regenerated on every re-sync.
//
// pnpm nests postcss under @tailwindcss/postcss's own .pnpm node_modules, so
// we anchor module resolution there (argv[2], or auto-discovered) and import
// by resolved absolute path (handles both CJS and ESM builds).
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

function findAnchor() {
  if (process.argv[2]) return process.argv[2];
  const pnpm = join(repoRoot, 'node_modules', '.pnpm');
  const dir = readdirSync(pnpm).find((d) => d.startsWith('@tailwindcss+postcss@'));
  if (!dir) throw new Error('could not find @tailwindcss/postcss in node_modules/.pnpm');
  return join(pnpm, dir, 'node_modules', '@tailwindcss', 'postcss', 'package.json');
}

const anchor = findAnchor();
if (!existsSync(anchor)) throw new Error(`anchor not found: ${anchor}`);
const req = createRequire(anchor);
const postcss = (await import(pathToFileURL(req.resolve('postcss')))).default;
const tailwindMod = await import(pathToFileURL(req.resolve('@tailwindcss/postcss')));
const tailwind = tailwindMod.default ?? tailwindMod;

const inPath = join(here, 'tw-input.css');
const outPath = join(here, 'styles.compiled.css');
const input = readFileSync(inPath, 'utf8');

const result = await postcss([tailwind()]).process(input, { from: inPath, to: outPath });
writeFileSync(outPath, result.css);
console.log(`[compile-css] ${(result.css.length / 1024).toFixed(0)} KB -> ${outPath}`);
