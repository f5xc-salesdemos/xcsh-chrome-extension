/**
 * Generate `capabilities.json` from the single-source descriptor (`src/capabilities.ts`).
 * This is the artifact xcsh vendors to generate its `ExtensionPage` interface +
 * LLM tool defs from one source, instead of hand-mirroring the contract.
 *
 *   bun scripts/gen-capabilities.ts            # write capabilities.json
 *   bun scripts/gen-capabilities.ts --check    # fail if stale (CI)
 *
 * `build.ts` imports `render()` and writes the file on every build, so it never
 * drifts from the code.
 */

import pkg from '../package.json';
import { buildCapabilities } from '../src/capabilities';

export const CAPABILITIES_PATH = new URL('../capabilities.json', import.meta.url).pathname;

export function render(): string {
  return `${JSON.stringify(buildCapabilities(pkg.version ?? '0.0.0'), null, 2)}\n`;
}

if (import.meta.main) {
  const fs = await import('node:fs');
  const json = render();
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(CAPABILITIES_PATH) ? fs.readFileSync(CAPABILITIES_PATH, 'utf8') : '';
    if (current !== json) {
      console.error('capabilities.json is stale — run: bun scripts/gen-capabilities.ts');
      process.exit(1);
    }
    console.log('capabilities.json is up to date');
  } else {
    fs.writeFileSync(CAPABILITIES_PATH, json);
    console.log(`wrote ${CAPABILITIES_PATH}`);
  }
}
