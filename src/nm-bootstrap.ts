/**
 * Pure decisions for the native-messaging (NM) auto-provisioning bootstrap.
 * Chrome-free and socket-free so it is unit-tested directly; service-worker.ts
 * owns the live `connectNative` port and tab tracking and delegates the two
 * trigger decisions here.
 *
 * `tenantKey` is the extension's `sessionKeyStr(...)` string ("tenant|env") —
 * the same key the xcsh worker advertises via hello_ack, so `provision`/`release`
 * on the manager line up with the bridge the Phase-3 scan later discovers.
 */

/**
 * Should the SW ask the manager to `provision` a worker for the focused tenant?
 * True iff a tenant tab is focused (`sessionKey` set), no bridge port currently
 * serves it (`activePort === undefined`, i.e. the Phase-3 scan found nothing),
 * and we are not pinned to a single manual port (which disables auto-discovery).
 */
export function shouldProvision(
  sessionKey: string | null,
  activePort: number | undefined,
  manualPortPinned: boolean,
): boolean {
  return sessionKey !== null && sessionKey !== '' && activePort === undefined && !manualPortPinned;
}

/**
 * Should the SW ask the manager to `release` the closed tab's tenant worker?
 * True when NONE of the still-open tabs belong to that tenant — i.e. the closed
 * tab was the tenant's last window. Callers derive `remainingTenantKeys` from
 * `chrome.tabs.query` + `sessionKeyFromUrl`/`sessionKeyStr`, keeping this pure.
 */
export function hasNoRemainingTenantTab(remainingTenantKeys: string[], closedKey: string): boolean {
  return !remainingTenantKeys.includes(closedKey);
}

/**
 * Should the panel show the contextless MOTD hint (guide the operator to run the
 * `/context` wizard)? True iff an xcsh session is present for the focused tenant
 * AND that worker is running contextless (`contextBound === false`, i.e. it has no
 * active stored context so API-backed features are unavailable). Non-blocking:
 * browser automation still works whether or not the hint is shown.
 */
export function shouldShowContextHint(sessionPresent: boolean, contextBound: boolean): boolean {
  return sessionPresent && contextBound === false;
}

/**
 * Which tenant (session key) the panel should show the contextless MOTD hint for,
 * derived from the FOCUSED tab's tenant and the live-bridge list — NOT the SW's
 * global single-session mirror (which reflects the last worker to ack, so under
 * multi-tenant a background contextless worker would wrongly flag the focused,
 * fully context-bound tenant). Returns the active tenant key iff it has a live
 * bridge whose worker is contextless (`contextBound !== true`); otherwise null
 * (context-bound, no focused tenant, or the tenant has no live bridge → the
 * disconnect case, which naturally clears any previously-shown hint). Reuses
 * `shouldShowContextHint` for the boolean decision.
 */
export function contextHintTenant(
  activeTenantKey: string | null,
  tenants: Array<{ tenant: string; contextBound?: boolean }>,
): string | null {
  if (!activeTenantKey) return null;
  const entry = tenants.find((t) => t.tenant === activeTenantKey);
  if (!entry) return null;
  return shouldShowContextHint(true, entry.contextBound === true) ? activeTenantKey : null;
}
