/**
 * Pure decisions for the chat panel's controlled-tab binding and bridge-link
 * liveness. Chrome-free and DOM-free so it is unit-tested; the service worker
 * wires Chrome events to `decideBinding` and the heartbeat timer to `isLinkStale`.
 */

/** F5 XC console tab? (same scope as the SW's host_permissions / isScopedUrl.) */
export function isConsoleUrl(url: string | undefined): boolean {
  if (!url) return false;
  return /^https:\/\/[^/]*\.volterra\.us\//.test(url) || /^https:\/\/[^/]*\.console\.ves\.volterra\.io\//.test(url);
}

/** DNS label: alphanumeric + hyphen, no leading/trailing hyphen (mirrors xcsh's xcsh-env.ts). */
const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export interface SessionKey {
  /** F5 XC tenant name, e.g. "nferreira". */
  tenant: string;
  /** Environment the tenant lives in. */
  env: 'production' | 'staging';
}

/**
 * The multi-session identity: map a console/login URL to its unique
 * `(tenant, environment)` session key. STRICTER and fail-closed vs
 * {@link isConsoleUrl}: an unrecognized host (bare volterra host, IP, the shared
 * SaaS console/realm, junk) yields `null`, so a tab never activates against the
 * wrong or a shared session. Staging and production of the same tenant name are
 * DISTINCT keys — the whole point of tenant isolation.
 *
 * Recognized shapes (mirrors xcsh's page-state-interpreter.ts):
 *   - `<tenant>.staging.volterra.us`        → (tenant, staging)
 *   - `<tenant>.console.ves.volterra.io`    → (tenant, production)
 *   - Keycloak `login[-staging].volterra.(us|io)` with a TENANT realm → (tenant, env)
 * The realm→tenant mapping is provisional and refined by the Phase 0b login-flow
 * capture; the shared `volterra` realm and the bare SaaS console fail closed.
 */
export function sessionKeyFromUrl(url: string | undefined): SessionKey | null {
  if (!url) return null;
  let hostname: string;
  let path: string;
  try {
    const u = new URL(url);
    hostname = u.hostname.toLowerCase();
    path = u.pathname;
  } catch {
    return null;
  }

  const staging = hostname.match(/^([a-z0-9-]+)\.staging\.volterra\.us$/);
  if (staging && DNS_LABEL_RE.test(staging[1])) return { tenant: staging[1], env: 'staging' };

  const prod = hostname.match(/^([a-z0-9-]+)\.console\.ves\.volterra\.io$/);
  if (prod && DNS_LABEL_RE.test(prod[1])) return { tenant: prod[1], env: 'production' };

  // Keycloak login page — derive the tenant from the realm (provisional). The
  // shared `volterra` realm (SaaS devportal login) has no single tenant → null.
  const isLoginHost =
    hostname === 'login.ves.volterra.io' || // production Keycloak
    hostname === 'login-staging.volterra.us' || // staging Keycloak
    /^login(-[a-z0-9]+)?\.volterra\.(us|io)$/.test(hostname);
  const oidc = path.match(/^\/auth\/realms\/([^/]+)\/protocol\/openid-connect/i);
  if (isLoginHost && oidc) {
    const realm = oidc[1].toLowerCase();
    if (realm === 'volterra') return null; // shared SaaS realm, not a tenant
    const tenant = realm.replace(/-[a-z0-9]+$/, ''); // strip realm suffix
    const env: 'production' | 'staging' = hostname.includes('staging') ? 'staging' : 'production';
    return DNS_LABEL_RE.test(tenant) ? { tenant, env } : null;
  }
  return null;
}

/** Stable string form of a session key, e.g. "nferreira|staging" — the key used
 * to index per-tenant conversations and route per-tenant connections. */
export function sessionKeyStr(key: SessionKey): string {
  return `${key.tenant}|${key.env}`;
}

export interface BindingState {
  controlledTabId: number | undefined;
  inFlight: boolean;
}

export type BindingEvent =
  | { kind: 'activated' | 'updated'; tabId: number; url: string | undefined }
  | { kind: 'removed'; tabId: number };

export type BindingAction =
  | { action: 'keep' }
  | { action: 'bind'; tabId: number }
  | { action: 'unbind' }
  | { action: 'inactive' };

/** Decide how a tab event changes the single controlled-tab binding. */
export function decideBinding(state: BindingState, event: BindingEvent): BindingAction {
  if (event.kind === 'removed') {
    return event.tabId === state.controlledTabId ? { action: 'unbind' } : { action: 'keep' };
  }
  if (event.kind === 'updated') {
    if (event.tabId !== state.controlledTabId) return { action: 'keep' };
    return isConsoleUrl(event.url) ? { action: 'keep' } : { action: 'unbind' };
  }
  // activated — automation always wins: never rebind while xcsh is busy.
  if (state.inFlight) return { action: 'keep' };
  if (!isConsoleUrl(event.url)) {
    return state.controlledTabId === undefined ? { action: 'inactive' } : { action: 'keep' };
  }
  if (event.tabId === state.controlledTabId) return { action: 'keep' };
  return { action: 'bind', tabId: event.tabId };
}

/**
 * Should the SW broadcast a `tab_bound` (ownership-change) event when the
 * controlled tab moves from `prev` to `next`? Only on a genuine change — the
 * first bind (`prev` undefined) or a switch to a different tab. Re-navigating
 * the already-bound tab (the agent's own first workflow step) must NOT
 * re-announce, or the panel ends the in-flight turn and blanks the transcript.
 */
export function shouldAnnounceBind(prev: number | undefined, next: number): boolean {
  return prev !== next;
}

/**
 * Panel-side defense-in-depth: is an inbound `tab_bound` for the tab the panel
 * already owns? If so it's a redundant re-bind (the agent navigated our own
 * tab), not a user tab-switch — refresh context only, never abort the active
 * turn or swap session. A first bind (`boundTabId` undefined) is NOT the same
 * tab, so it stays disruptive (loads that tab's session).
 */
export function isSameTabRebind(incomingTabId: number, boundTabId: number | undefined): boolean {
  return boundTabId !== undefined && incomingTabId === boundTabId;
}

/**
 * Should an inbound `tab_bound` abort the in-flight turn and swap the panel to
 * that tab's session? Only for a genuine user tab-switch while IDLE. Two cases
 * must be adopted silently (chip refresh only, no abort):
 *  - a same-tab rebind ([[isSameTabRebind]]), and
 *  - ANY bind while a turn is in flight — that's the turn's own automation
 *    binding the tab it is driving. This includes the FIRST bind, since the
 *    flagship flow starts on an unbound tab and the first navigate binds it
 *    mid-turn; without this the transcript blanks exactly when automation begins.
 */
export function bindIsDisruptive(
  incomingTabId: number,
  boundTabId: number | undefined,
  hasActiveTurn: boolean,
): boolean {
  if (isSameTabRebind(incomingTabId, boundTabId)) return false;
  if (hasActiveTurn) return false;
  return true;
}

/** Open-but-silent socket detection: no inbound bridge traffic for > intervalMs. */
export function isLinkStale(lastActivityTs: number, now: number, intervalMs: number): boolean {
  return now - lastActivityTs > intervalMs;
}
