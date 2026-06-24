#!/usr/bin/env node
/**
 * Inject the `key` field into dist/manifest.json for a LOCAL DEVELOPMENT build.
 *
 * The `key` is the extension's PUBLIC key (base64) — it is NOT secret (it ships
 * inside every published manifest, and Chrome derives the extension ID from it).
 * This is the EXACT public key of the published Chrome Web Store item, so a
 * developer who builds + loads `dist/` unpacked gets the SAME canonical ID as
 * store users (`klajkjdoehjidngligegnpknogmjjhkc`). That is what the xcsh native
 * messaging host (`xcsh chrome setup`) allows, so the native bridge works while
 * developing — without this key, an unpacked load gets a throwaway path-derived
 * ID and the bridge cannot connect.
 *
 * This is for LOCAL DEV ONLY (`bun run build:dev`). It is NOT part of the release
 * path: the Chrome Web Store upload must ship WITHOUT a `key` (CWS assigns the ID
 * from its own keypair and rejects manifests carrying a `key`).
 *
 * Usage: node scripts/inject-key.mjs   (operates on dist/manifest.json)
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

// Public key (base64 SPKI DER) of the published Chrome Web Store item. Extracted
// from the store CRX and verified to derive to EXPECTED_ID by the check below.
const KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxH7u98l7G7pMnn1ktkrlgl7QwA526u0p9Ry7wGBB5YMJYKWFXUivBLTvs4saWi94RSWDNamf0yrmynu/xvxcl+HVZpWZ4dgmmLKywh9ZX0cv0nXt7I02xp3jck3PEyZBS/KnSwG7xTpJJaKm3ho57W/SVvNssLidzoByLRU/HzO9l+z3g6sfmBiJmW+GLejyFYTo2AwtexkLfNEhEBa1M/P75Ffm9IEiyty3n08yGc37YSWmSSGm+TV3hgWuKMYMa+pbKw0FsA2gYuJ6WzSIeCLhx0/Uo/wk+TB62ZLPs1it4lQYv8caUB0WzKquoH/57h0NKME7y/nvAolkf70C4wIDAQAB';

// The one canonical ID — the published Chrome Web Store item ID.
const EXPECTED_ID = 'klajkjdoehjidngligegnpknogmjjhkc';

/**
 * Derive a Chrome extension ID from a base64 public key, exactly as Chrome does:
 * SHA-256 of the DER bytes, take the first 128 bits (32 hex chars), and map each
 * hex digit 0–f onto a–p.
 */
function deriveExtensionId(b64) {
  const digest = createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');
  return [...digest.slice(0, 32)].map((c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join('');
}

// Guard against ID drift: if KEY ever stops matching the published item, fail the
// build loudly instead of silently shipping a dev build under the wrong ID.
const derivedId = deriveExtensionId(KEY);
if (derivedId !== EXPECTED_ID) {
  throw new Error(
    `inject-key: KEY derives to "${derivedId}" but the canonical store ID is "${EXPECTED_ID}". ` +
      'Refusing to write a manifest with a mismatched extension ID.',
  );
}

const path = 'dist/manifest.json';
const m = JSON.parse(readFileSync(path, 'utf8'));
// Put `key` near the top (after the existing first three fields); order is cosmetic.
const withKey = { manifest_version: m.manifest_version, name: m.name, version: m.version, key: KEY, ...m };
writeFileSync(path, `${JSON.stringify(withKey, null, 2)}\n`);
console.log(`inject-key: local-dev manifest keyed → ${derivedId}`);
