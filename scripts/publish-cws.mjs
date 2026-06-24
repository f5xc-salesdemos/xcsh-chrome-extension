#!/usr/bin/env node
/**
 * Upload + publish the Chrome Web Store package, with HONEST error handling.
 *
 * Wraps `chrome-webstore-upload-cli@3` (which reads the OAuth credentials from
 * the EXTENSION_ID / CLIENT_ID / CLIENT_SECRET / REFRESH_TOKEN env vars). Unlike a
 * blanket `... || echo warning`, this classifies failures:
 *
 *   - SUCCESS                      → exit 0
 *   - transient "previous version  → ::warning:: + exit 0 (the new version is
 *     still in review"               uploaded/queued and publishes once review
 *     (ITEM_NOT_UPDATABLE)           clears; this must not fail the release)
 *   - ANYTHING ELSE (bad/expired   → ::error:: + exit 1 (fail the release loudly
 *     credentials, network, quota,   so a real break is visible, never silently
 *     wrong EXTENSION_ID, …)         swallowed)
 *
 * Usage: node scripts/publish-cws.mjs [version]
 */
import { execFileSync } from 'node:child_process';

const ZIP = 'xcsh-chrome-extension.zip';
const CLI = ['--yes', 'chrome-webstore-upload-cli@3'];
// Markers that mean "the item is locked because a prior submission is in review"
// — the one failure we tolerate (the release still ships; CWS publishes later).
const TRANSIENT = /ITEM_NOT_UPDATABLE|in[\s_-]?review|currently being reviewed|pending review/i;

const version = process.argv[2] ?? '';

for (const name of ['EXTENSION_ID', 'CLIENT_ID', 'CLIENT_SECRET', 'REFRESH_TOKEN']) {
  if (!process.env[name]) {
    console.error(`::error::publish-cws: missing required env var ${name}`);
    process.exit(1);
  }
}

/** Run a CWS CLI subcommand, capturing output. Returns { ok, output }. */
function run(args) {
  try {
    const output = execFileSync('npx', [...CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    process.stdout.write(output);
    return { ok: true, output };
  } catch (err) {
    return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

function defer(step) {
  console.log(
    `::warning::Chrome Web Store ${step} deferred — a previous submission is still in review. ` +
      `v${version || '(next)'} is uploaded/queued and will publish automatically once review clears.`,
  );
  process.exit(0);
}

function fail(step, output) {
  console.error(`::error::Chrome Web Store ${step} failed:`);
  if (output) console.error(output);
  process.exit(1);
}

const uploaded = run(['upload', '--source', ZIP]);
if (!uploaded.ok) {
  if (TRANSIENT.test(uploaded.output)) defer('upload'); // exits 0
  fail('upload', uploaded.output); // exits 1
}

const published = run(['publish']);
if (!published.ok) {
  if (TRANSIENT.test(published.output)) defer('publish'); // exits 0
  fail('publish', published.output); // exits 1
}

console.log(`publish-cws: uploaded + published${version ? ` v${version}` : ''} to the Chrome Web Store.`);
