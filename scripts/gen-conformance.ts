/**
 * Generate `chat-conformance.json` — the cross-repo chat-protocol conformance
 * artifact: JSON Schemas for every chat wire message + the page-context
 * snapshot, plus golden valid/invalid examples. xcsh vendors this file and runs
 * the same schemas + examples against its parser/serializer, so the two sides
 * stay in lockstep.
 *
 *   bun scripts/gen-conformance.ts            # write chat-conformance.json
 *   bun scripts/gen-conformance.ts --check    # fail if stale (CI)
 *
 * Reuses the Biome-compatible serializer from gen-capabilities so the committed
 * artifact stays lint-clean across regenerations.
 */

import { CHAT_EXAMPLES, CHAT_SCHEMAS, PageContextSnapshotSchema } from '../src/chat-schema';
import { formatBiomeJson } from './gen-capabilities';

export const CONFORMANCE_PATH = new URL('../chat-conformance.json', import.meta.url).pathname;

export function renderConformance(): string {
  const schemas = { ...CHAT_SCHEMAS, page_context_snapshot: PageContextSnapshotSchema };
  return `${formatBiomeJson({ contractVersion: '1.2.0', schemas, examples: CHAT_EXAMPLES })}\n`;
}

if (import.meta.main) {
  const fs = await import('node:fs');
  const json = renderConformance();
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(CONFORMANCE_PATH) ? fs.readFileSync(CONFORMANCE_PATH, 'utf8') : '';
    if (current !== json) {
      console.error('chat-conformance.json is stale — run: bun scripts/gen-conformance.ts');
      process.exit(1);
    }
    console.log('chat-conformance.json is up to date');
  } else {
    fs.writeFileSync(CONFORMANCE_PATH, json);
    console.log(`wrote ${CONFORMANCE_PATH}`);
  }
}
