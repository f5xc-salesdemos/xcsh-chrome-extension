# xcsh Chrome Extension — Privacy Policy

**Last updated:** June 22, 2026

## What this extension does

xcsh is a browser automation extension that drives the F5 Distributed Cloud admin console on behalf of the xcsh AI assistant. It operates exclusively on F5 XC console domains (*.volterra.us, *.console.ves.volterra.io).

## Data collection and usage

### What we access
- **Page DOM/Accessibility Tree:** The extension reads the structure of F5 XC console pages to identify form fields, buttons, and navigation elements. This data is used locally for automation and is never transmitted externally.
- **Console logs and network requests:** When explicitly requested by the user, the extension reads Chrome DevTools console and network data for debugging purposes. This data stays local.
- **Screenshots:** When requested, the extension captures the visible tab as a JPEG image, transmitted locally to the xcsh CLI via the native-messaging bridge. Screenshots are never sent to external servers.

### What we do NOT collect
- We do NOT collect browsing history
- We do NOT collect personally identifiable information
- We do NOT track user behavior or analytics
- We do NOT collect data from non-F5-XC websites
- We do NOT use cookies or tracking pixels

### Credentials
- Login credentials (email/password) are passed per-invocation from the xcsh CLI through the local native-messaging bridge
- Credentials are held in-memory only for the duration of the login operation
- Credentials are NEVER persisted to extension storage, local storage, or disk by the extension
- The extension never transmits credentials to any external server

## Data transmission

All communication between the extension and the xcsh CLI occurs through Chrome's native-messaging API over a local Unix domain socket. No data leaves your machine. There is no cloud component, no telemetry, and no external API calls made by the extension.

## Enterprise policy

The extension supports Chrome Enterprise managed policy via `managed_schema.json`:
- `allowedDomains`: IT can restrict which domains the extension operates on
- `blockedUrlPatterns`: IT can block specific URL patterns
- `confirmBeforeMutating`: IT can require user confirmation before destructive actions

These policies are read-only to the extension and configured by your organization's Chrome administrator.

## Third-party services

This extension does not use any third-party services, analytics, or tracking.

## Changes to this policy

We may update this privacy policy from time to time. Changes will be reflected in the "Last updated" date above.

## Contact

For questions about this privacy policy, please open an issue at:
https://github.com/f5-sales-demo/xcsh-chrome-extension/issues
