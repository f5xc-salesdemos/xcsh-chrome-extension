import * as fs from 'node:fs';
import { CAPABILITIES_PATH, render as renderCapabilities } from './scripts/gen-capabilities';
import { CONFORMANCE_PATH, renderConformance } from './scripts/gen-conformance';

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

await Bun.build({
  entrypoints: ['src/side-panel.ts'],
  outdir: 'dist',
  target: 'browser',
  minify: false,
  format: 'esm',
});

fs.copyFileSync('manifest.json', 'dist/manifest.json');
// The Chrome Web Store assigns the extension ID, so the PUBLISHED dist must not
// contain a `key`. We keep `key` in source (and local dev builds) to pin the
// unpacked extension's ID for the loopback origin check, but strip it from CI/
// production builds so the CWS dist-check passes and the store can assign the ID.
if (process.env.CI) {
  const manifestPath = 'dist/manifest.json';
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if ('key' in manifest) {
    delete manifest.key;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}
fs.copyFileSync('managed_schema.json', 'dist/managed_schema.json');
fs.copyFileSync('src/options.html', 'dist/options.html');
fs.copyFileSync('src/side-panel.html', 'dist/side-panel.html');

// Copy branded icons.
fs.mkdirSync('dist/icons', { recursive: true });
for (const s of [16, 48, 128]) {
  fs.copyFileSync(`icons/icon-${s}.png`, `dist/icons/icon-${s}.png`);
}

// Regenerate the published capability contract from the single-source descriptor
// (src/capabilities.ts) so capabilities.json never drifts from the code.
fs.writeFileSync(CAPABILITIES_PATH, renderCapabilities());

// Regenerate the cross-repo chat-protocol conformance artifact (schemas + golden
// examples) from src/chat-schema.ts so xcsh can vendor + validate against it.
fs.writeFileSync(CONFORMANCE_PATH, renderConformance());

console.log('built dist/');
