/**
 * semantic-release config for the xcsh Chrome extension.
 *
 * Conventional commits drive the version increment (angular preset). On each
 * push to main, semantic-release:
 *   1. determines the next version from commit messages
 *   2. writes that version into manifest.json + package.json (set-version.mjs)
 *   3. builds dist/ and zips it (one store package — no `key`)
 *   4. uploads + publishes that zip to the Chrome Web Store (scripts/publish-cws.mjs)
 *   5. creates a GitHub release (tag + notes) with the store zip attached
 *
 * The Chrome Web Store is the single distribution channel — there is no unpacked
 * GitHub-release artifact. No version-bump commit lands on main (no
 * @semantic-release/git): the released version lives in the git tag + GitHub
 * release + the published CWS package, stamped at build time by set-version.mjs.
 *
 * Required GitHub secrets:
 *   RELEASE_TOKEN          — GitHub PAT (org-level)
 *   CHROME_EXTENSION_ID    — Chrome Web Store item ID
 *   CHROME_CLIENT_ID       — Chrome Web Store API OAuth client id
 *   CHROME_CLIENT_SECRET   — Chrome Web Store API OAuth client secret
 *   CHROME_REFRESH_TOKEN   — Chrome Web Store API OAuth refresh token
 */
export default {
  branches: ['main'],
  plugins: [
    [
      '@semantic-release/commit-analyzer',
      {
        preset: 'angular',
        releaseRules: [
          { breaking: true, release: 'major' },
          { type: 'feat', release: 'minor' },
          { type: 'fix', release: 'patch' },
          { type: 'perf', release: 'patch' },
          { type: 'revert', release: 'patch' },
          { type: 'refactor', release: 'patch' },
          { type: 'build', release: 'patch' },
          { type: 'ci', release: 'patch' },
        ],
      },
    ],
    '@semantic-release/release-notes-generator',
    [
      '@semantic-release/exec',
      {
        // Fail EARLY (before any version commit/tag) if CWS credentials are
        // missing — prevents a half-done release (tag pushed, publish failed).
        verifyConditionsCmd:
          'test -n "$EXTENSION_ID" && test -n "$CLIENT_ID" && test -n "$CLIENT_SECRET" && test -n "$REFRESH_TOKEN" || (echo "Missing Chrome Web Store credentials (EXTENSION_ID/CLIENT_ID/CLIENT_SECRET/REFRESH_TOKEN)" && exit 1)',
        // Build ONE artifact: xcsh-chrome-extension.zip — the store package, with
        // NO `key` (CWS assigns the ID from its own keypair and rejects a `key`).
        // Local-dev keying lives in `bun run build:dev`, never in the release.
        prepareCmd:
          // biome-ignore lint/suspicious/noTemplateCurlyInString: semantic-release template syntax
          "node scripts/set-version.mjs ${nextRelease.version} && bun install --frozen-lockfile && bun run build && (cd dist && zip -r ../xcsh-chrome-extension.zip . -x '*.DS_Store')",
        // Upload + publish to the Chrome Web Store. publish-cws.mjs fails the
        // release on real errors (bad credentials, wrong EXTENSION_ID, network)
        // and tolerates only the transient case — a previous submission still in
        // review (ITEM_NOT_UPDATABLE) — which publishes once review clears.
        publishCmd:
          // biome-ignore lint/suspicious/noTemplateCurlyInString: semantic-release template syntax
          'node scripts/publish-cws.mjs ${nextRelease.version}',
      },
    ],
    [
      '@semantic-release/github',
      {
        assets: [
          // biome-ignore lint/suspicious/noTemplateCurlyInString: semantic-release template syntax
          { path: 'xcsh-chrome-extension.zip', label: 'Chrome Web Store package — v${nextRelease.version}' },
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
