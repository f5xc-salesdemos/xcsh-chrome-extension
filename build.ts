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
