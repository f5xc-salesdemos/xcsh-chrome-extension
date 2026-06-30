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
 *
 * Output is formatted to match Biome's JSON formatter (the repo's lint/format
 * authority, run as `biome ci .` in CI) so the committed artifact stays
 * lint-clean across regenerations. Plain `JSON.stringify(…, 2)` always expands
 * arrays one-element-per-line, but Biome collapses a short array onto a single
 * line when it fits within the line width — so we replicate that here rather
 * than fight the formatter (and rather than couple the build to the Biome
 * binary). Biome always expands non-empty objects, so only arrays differ.
 */

import pkg from '../package.json';
import { buildCapabilities } from '../src/capabilities';

export const CAPABILITIES_PATH = new URL('../capabilities.json', import.meta.url).pathname;

// Mirrors biome.json: 2-space indent, 120-column line width.
const INDENT = '  ';
const LINE_WIDTH = 120;

/** True if `v` never forces a line break, so an array of such values may collapse. */
function isFlatSafe(v: unknown): boolean {
  if (Array.isArray(v)) return v.every(isFlatSafe);
  if (v !== null && typeof v === 'object') return Object.keys(v).length === 0; // only {} is flat
  return true; // primitives
}

/** Single-line rendering of a flat-safe value (primitives, [], {}, flat arrays). */
function flat(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(flat).join(', ')}]`;
  if (v !== null && typeof v === 'object') return '{}'; // only reached for empty objects
  return JSON.stringify(v);
}

/**
 * Biome-compatible JSON. `column` is where this value begins on its line (so the
 * array-fit decision accounts for the `"key": ` prefix, exactly as Biome does).
 */
function format(v: unknown, depth: number, column: number): string {
  const pad = INDENT.repeat(depth);
  const padIn = INDENT.repeat(depth + 1);

  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    if (isFlatSafe(v)) {
      const oneLine = flat(v);
      if (column + oneLine.length <= LINE_WIDTH) return oneLine;
    }
    const items = v.map((e) => `${padIn}${format(e, depth + 1, padIn.length)}`);
    return `[\n${items.join(',\n')}\n${pad}]`;
  }

  if (v !== null && typeof v === 'object') {
    const entries = Object.entries(v);
    if (entries.length === 0) return '{}';
    const items = entries.map(([k, val]) => {
      const prefix = `${JSON.stringify(k)}: `;
      return `${padIn}${prefix}${format(val, depth + 1, padIn.length + prefix.length)}`;
    });
    return `{\n${items.join(',\n')}\n${pad}}`;
  }

  return JSON.stringify(v);
}

/** Biome-compatible JSON for an arbitrary value (no trailing newline). Exported for tests. */
export function formatBiomeJson(value: unknown): string {
  return format(value, 0, 0);
}

/** Render the capability manifest as Biome-formatted JSON (trailing newline). */
export function render(): string {
  return `${formatBiomeJson(buildCapabilities(pkg.version ?? '0.0.0'))}\n`;
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
