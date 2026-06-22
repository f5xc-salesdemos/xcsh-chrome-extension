#!/usr/bin/env node
/**
 * Inject the `key` field into dist/manifest.json to produce the keyed UNPACKED
 * build. The `key` is the extension's PUBLIC key (base64) — it is NOT secret
 * (it ships inside every published manifest). It pins the unpacked extension's
 * ID to `khlalklompggpfnmeclpligmcbknkemg`, which is the ID the xcsh native
 * messaging host (`xcsh chrome setup`) allows — so the native bridge works for
 * users who install the extension unpacked from a GitHub release.
 *
 * The Chrome Web Store build must NOT contain `key` (CWS assigns its own ID and
 * rejects manifests with a `key` field), so this runs only for the unpacked zip.
 *
 * Usage: node scripts/inject-key.mjs   (operates on dist/manifest.json)
 */
import { readFileSync, writeFileSync } from "node:fs";

const KEY =
	"MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA3Q7iX3+RGZ6S96woYRttfvh5LJ8haJ7HVK66wmR+e3VS4pRzB+r8EOfMRv/wqjlT5duBrDz01KHB8CFyTXvk3UpHFIK5J0riMFJqwGLya2jy3EJPpKsHYsfxtrK0rWqwQ7wMqrjq6DUCo5SB9Rsl36LDaSA8vjrKL3jfQZUQwsqCVuiNtQUW/u70jadqrbHkDbIqFUHmBGAbQT2EpCb6Hj3lcLyDuOMR+lm0HgA3FPcf/bZpFLYGobtjvTl1VZ4eMUMYfy+u6BElMIkaNUaw4m9tI2jVtywGCZQk+8QY+l3nAdqdf2WsNgD75PO0pmBL8D0kzxYzDZlwEDZa8zmOQQIDAQAB";

const path = "dist/manifest.json";
const m = JSON.parse(readFileSync(path, "utf8"));
// `key` must be the first sibling of other top-level fields; order is cosmetic.
const withKey = { manifest_version: m.manifest_version, name: m.name, version: m.version, key: KEY, ...m };
writeFileSync(path, `${JSON.stringify(withKey, null, 2)}\n`);
console.log(`inject-key: added key to ${path} (unpacked ID → khlalklompggpfnmeclpligmcbknkemg)`);
