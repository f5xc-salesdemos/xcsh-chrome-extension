import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CAPABILITIES_PATH, render as renderCapabilities } from './scripts/gen-capabilities';

await Bun.build({
  entrypoints: ['src/accessibility-tree.ts'],
  outdir: 'dist',
  target: 'browser',
  minify: false,
  format: 'iife', // Content scripts must be classic scripts (not ESM) — an `export` causes SyntaxError
});

await Bun.build({
  entrypoints: ['src/service-worker.ts'],
  outdir: 'dist',
  target: 'browser',
  minify: false,
  format: 'esm',
});

await Bun.build({
  entrypoints: ['src/agent-visual-indicator.ts'],
  outdir: 'dist',
  target: 'browser',
  minify: false,
  format: 'iife', // Content script — must be classic script
});

await Bun.build({
  entrypoints: ['src/options.ts'],
  outdir: 'dist',
  target: 'browser',
  minify: false,
});

fs.copyFileSync('manifest.json', 'dist/manifest.json');
fs.copyFileSync('managed_schema.json', 'dist/managed_schema.json');
fs.copyFileSync('src/options.html', 'dist/options.html');

// Copy branded icons.
fs.mkdirSync('dist/icons', { recursive: true });
for (const s of [16, 48, 128]) {
  fs.copyFileSync(`icons/icon-${s}.png`, `dist/icons/icon-${s}.png`);
}

// Regenerate the published capability contract from the single-source descriptor
// (src/capabilities.ts) so capabilities.json never drifts from the code.
fs.writeFileSync(CAPABILITIES_PATH, renderCapabilities());

console.log('built dist/');

// Embed the dev key into dist/manifest.json for a stable unpacked extension ID.
// Without this, every build produces a different ID → Chrome creates a duplicate.
const keyPem = path.resolve(import.meta.dir, "key.pem");
if (fs.existsSync(keyPem)) {
  const der = execFileSync('openssl', ['rsa', '-in', keyPem, '-pubout', '-outform', 'DER'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const manifest = JSON.parse(fs.readFileSync(path.resolve(import.meta.dir, "dist/manifest.json"), "utf8"));
  manifest.key = der.toString("base64");
  fs.writeFileSync(path.resolve(import.meta.dir, "dist/manifest.json"), JSON.stringify(manifest, null, 2));
  console.log('embedded dev key → stable unpacked ID');
}
