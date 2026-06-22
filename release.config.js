/**
 * semantic-release config for the xcsh Chrome extension.
 *
 * Conventional commits drive the version increment (angular preset). On each
 * push to main, semantic-release:
 *   1. determines the next version from commit messages
 *   2. writes that version into manifest.json + package.json (set-version.mjs)
 *   3. builds dist/ and zips it
 *   4. uploads + publishes the zip to the Chrome Web Store (chrome-webstore-upload-cli)
 *   5. creates a GitHub release with the zip attached
 *   6. commits the version bump back to main
 *
 * Required GitHub secrets:
 *   RELEASE_TOKEN          — GitHub PAT (org-level)
 *   CHROME_EXTENSION_ID    — Chrome Web Store item ID
 *   CHROME_CLIENT_ID       — Chrome Web Store API OAuth client id
 *   CHROME_CLIENT_SECRET   — Chrome Web Store API OAuth client secret
 *   CHROME_REFRESH_TOKEN   — Chrome Web Store API OAuth refresh token
 */
export default {
	branches: ["main"],
	plugins: [
		[
			"@semantic-release/commit-analyzer",
			{
				preset: "angular",
				releaseRules: [
					{ breaking: true, release: "major" },
					{ type: "feat", release: "minor" },
					{ type: "fix", release: "patch" },
					{ type: "perf", release: "patch" },
					{ type: "revert", release: "patch" },
					{ type: "refactor", release: "patch" },
					{ type: "build", release: "patch" },
					{ type: "ci", release: "patch" },
				],
			},
		],
		"@semantic-release/release-notes-generator",
		[
			"@semantic-release/exec",
			{
				// Fail EARLY (before any version commit/tag) if CWS credentials are
				// missing — prevents a half-done release (tag pushed, publish failed).
				verifyConditionsCmd:
					'test -n "$EXTENSION_ID" && test -n "$CLIENT_ID" && test -n "$CLIENT_SECRET" && test -n "$REFRESH_TOKEN" || (echo "Missing Chrome Web Store credentials (EXTENSION_ID/CLIENT_ID/CLIENT_SECRET/REFRESH_TOKEN)" && exit 1)',
				// Build TWO artifacts:
				//  1. xcsh-chrome-extension.zip          — no `key` (Chrome Web Store)
				//  2. xcsh-chrome-extension-unpacked.zip — with `key` (stable ID for
				//     unpacked install from the GitHub release — native messaging works)
				prepareCmd:
					"node scripts/set-version.mjs ${nextRelease.version} && bun install --frozen-lockfile && bun run build && (cd dist && zip -r ../xcsh-chrome-extension.zip . -x '*.DS_Store') && node scripts/inject-key.mjs && (cd dist && zip -r ../xcsh-chrome-extension-unpacked.zip . -x '*.DS_Store')",
				// Upload + publish to the Chrome Web Store — fully BEST-EFFORT. While the
				// item is in review the upload fails (ITEM_NOT_UPDATABLE); that must NOT
				// abort the release, because the GitHub release (with the unpacked zip) is
				// the interim distribution. Once review clears, future releases publish.
				publishCmd:
					'(npx --yes chrome-webstore-upload-cli@3 upload --source xcsh-chrome-extension.zip && npx --yes chrome-webstore-upload-cli@3 publish) || echo "::warning::Chrome Web Store deferred (item in review) — install v${nextRelease.version} from the GitHub release (unpacked) until the listing is approved"',
			},
		],
		[
			"@semantic-release/github",
			{
				assets: [
					{ path: "xcsh-chrome-extension-unpacked.zip", label: "Install (unpacked) — v${nextRelease.version}" },
					{ path: "xcsh-chrome-extension.zip", label: "Chrome Web Store package — v${nextRelease.version}" },
				],
			},
		],
		// No @semantic-release/git: the released version lives in the git tag +
		// GitHub release + the published CWS package, NOT in a bot-commit to main.
		// The build sets the version at release time (set-version.mjs). This keeps
		// main clean and ensures the tag is only created on a SUCCESSFUL publish
		// (so a failed CWS upload never leaves a dangling tag/commit).
	],
};
