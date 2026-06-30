/**
 * xcsh service worker — WebSocket bridge client + the 5 tools.
 *
 * Connects to xcsh's bridge server over WebSocket (`ws://127.0.0.1:19222`),
 * handles the tool protocol (`tool_request` -> `tool_result`, `ping` -> `pong`),
 * and drives the scoped F5 XC console tab via chrome.scripting + chrome.debugger.
 */

import { isJsonMime, isXcResourceApi, resourceTypeFromUrl, shouldFetchBody } from './api-capture';
import { buildCapabilities, getToolDef, toolNames } from './capabilities';
import { isChatInbound } from './chat-protocol';
import { type AxLike, buildContextSnapshot, type RawApiCapture } from './context-snapshot';
import { runDispatch } from './dispatch';
import { type AxNode, matchNode, matchNodes, parseLocator } from './vendored-resolver';

const BRIDGE_URL = 'ws://127.0.0.1:19222';
const MANAGED_POLICY_ALARM = 'managed-policy-refresh';
const VERSION = '0.1.0';
const NAV_TIMEOUT_MS = 30_000;

// Max size of code accepted by `javascript_tool` (defense-in-depth, Phase 1).
const MAX_JS_CODE_LEN = 100_000;

// --- Managed enterprise policy (chrome.storage.managed) --------------------
//
// Keys come from `managed_schema.json` and are pushed by enterprise policy
// (e.g. Google Admin console / Windows GPO / macOS plist). The schema is
// advisory only; managed storage is read-only to the extension.
type ManagedPolicy = {
  allowedDomains?: string[];
  blockedUrlPatterns?: string[];
  // Phase 3: documented no-op stub. The permission_request/response bridge
  // protocol that would consume this is deferred to a later phase. We read +
  // cache the value so it is observable, but it does not gate anything yet.
  confirmBeforeMutating?: boolean;
};

let managedPolicy: ManagedPolicy = {};

async function refreshManagedPolicy(): Promise<void> {
  try {
    const stored = await chrome.storage.managed.get(['allowedDomains', 'blockedUrlPatterns', 'confirmBeforeMutating']);
    managedPolicy = {
      allowedDomains: Array.isArray(stored.allowedDomains) ? (stored.allowedDomains as string[]) : undefined,
      blockedUrlPatterns: Array.isArray(stored.blockedUrlPatterns)
        ? (stored.blockedUrlPatterns as string[])
        : undefined,
      confirmBeforeMutating:
        typeof stored.confirmBeforeMutating === 'boolean' ? (stored.confirmBeforeMutating as boolean) : undefined,
    };
  } catch {
    // No managed storage configured (common in dev / unmanaged installs).
    // Leave the cached policy as-is.
  }
}

/** True if `url` matches any configured blocked pattern (normalized, case-insensitive). */
function isBlockedUrl(url: string): boolean {
  const patterns = managedPolicy.blockedUrlPatterns;
  if (!patterns || patterns.length === 0) return false;
  // Normalize: decode percent-encoding + lowercase to prevent bypass via encoding tricks.
  let normalized: string;
  try {
    const parsed = new URL(url);
    normalized = decodeURIComponent(`${parsed.origin}${parsed.pathname}${parsed.search}`).toLowerCase();
  } catch {
    normalized = decodeURIComponent(url).toLowerCase();
  }
  return patterns.some((p) => typeof p === 'string' && p.length > 0 && normalized.includes(p.toLowerCase()));
}

// Scoped console URL patterns (also the host_permissions in the manifest).
const SCOPED_QUERY_PATTERNS = ['https://*.volterra.us/*', 'https://*.console.ves.volterra.io/*'];

function isScopedUrl(url: string): boolean {
  return /^https:\/\/[^/]*\.volterra\.us\//.test(url) || /^https:\/\/[^/]*\.console\.ves\.volterra\.io\//.test(url);
}

/** Hostname-anchored Keycloak login URL check. */
const KC_LOGIN_HOST = /(?:^|\.)volterra\.us$|(?:^|\.)console\.ves\.volterra\.io$/;
function isKeycloakLoginUrl(u: string): boolean {
  try {
    const { hostname, pathname } = new URL(u);
    return KC_LOGIN_HOST.test(hostname) && /\/auth\/realms\/|\/login-actions\//.test(pathname);
  } catch {
    return false;
  }
}

// --- WebSocket bridge connection + lifecycle -------------------------------

let ws: WebSocket | null = null;

// The console tab the SW is currently driving (set in `navigate`).
let targetTabId: number | undefined;

// Cached login credentials for session-expiry auto-recovery. Set by login(),
// used by navigate() to transparently re-authenticate when the session expires.
// In-memory only — never persisted.
let lastLoginCredentials: { email: string; password: string; consoleUrl: string } | null = null;
// True while login() is driving its initial navigate(). navigate()'s
// session-expiry auto-recovery must skip re-invoking login() during this window,
// else login()→navigate()→recovery→login()→… recurses infinitely, issuing a
// fresh OIDC request (new state/nonce) every cycle and never settling.
let loginInProgress = false;

// Tabs we have attached the debugger to, so we can detach on cleanup and avoid
// re-attaching needlessly.
const attachedTabs = new Set<number>();

// Explain mode: when true, the agent is doing a deliberate, human-paced
// walkthrough and on-page annotation overlays (fingerprints, highlights) are
// shown. OFF by default — under fast automation overlays are a confusing blur.
// Set by the `set_explain_mode` tool; in-memory only (a walkthrough runs well
// within the SW keepalive window).
let explainMode = false;

// Allowed console URL patterns for tabs_list (mirrors host_permissions).
const ALLOWED_PATTERNS = ['https://*.volterra.us/*', 'https://*.console.ves.volterra.io/*'];

// --- Diagnostic event buffers (read_console / read_network) ----------------

// Ring buffers of CDP events, capped at 500 entries each.
// biome-ignore lint/suspicious/noExplicitAny: Chrome extension API typings
const consoleBuffer: any[] = [];
// biome-ignore lint/suspicious/noExplicitAny: Chrome extension API typings
const networkBuffer: any[] = [];
let observingConsole = false;
let observingNetwork = false;

// Chat: panel Ports keyed by chat-turn id ("c-…"), and the latest captured XC
// API response per tab (ground-truth for the page-context snapshot).
const turnToPort = new Map<string, chrome.runtime.Port>();
type ApiCapture = RawApiCapture & { mimeType?: string };
const latestApiCapture = new Map<number, ApiCapture>();
// Pending request bodies we want, awaiting Network.loadingFinished.
const pendingApi = new Map<
  string,
  { tabId: number; url: string; status: number; resourceType: string | null; mimeType?: string }
>();

async function enableConsoleObserver(): Promise<void> {
  if (observingConsole) return;
  const tabId = requireTab();
  await ensureDebuggerAttached(tabId);
  await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable', {});
  observingConsole = true;
}

async function enableNetworkObserver(): Promise<void> {
  if (observingNetwork) return;
  const tabId = requireTab();
  await ensureDebuggerAttached(tabId);
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {});
  observingNetwork = true;
}

// Push CDP events for the target tab into the diagnostic ring buffers.
chrome.debugger.onEvent.addListener((source, method, eventParams) => {
  if (source.tabId === undefined) return;
  // Auto-handle native JS dialogs (beforeunload "Leave site?", alert, confirm)
  // so they never block the page / freeze the debugger — automation flows
  // naturally without popups. Accept so navigation proceeds.
  if (method === 'Page.javascriptDialogOpening') {
    chrome.debugger
      .sendCommand({ tabId: source.tabId }, 'Page.handleJavaScriptDialog', { accept: true })
      .catch(() => {});
    return;
  }
  if (source.tabId !== targetTabId) return;
  if (method === 'Runtime.consoleAPICalled') {
    consoleBuffer.push(eventParams);
    if (consoleBuffer.length > 500) consoleBuffer.shift();
  } else if (method === 'Network.requestWillBeSent' || method === 'Network.responseReceived') {
    // biome-ignore lint/suspicious/noExplicitAny: Chrome extension API typings
    networkBuffer.push({ method, ...(eventParams as any) });
    if (networkBuffer.length > 500) networkBuffer.shift();
    // Passive XC resource capture: note JSON resource responses, fetch the body
    // on loadingFinished (bodies evict fast, so we can't wait until snapshot time).
    if (method === 'Network.responseReceived') {
      // biome-ignore lint/suspicious/noExplicitAny: CDP event shape
      const e = eventParams as any;
      const url: string = e.response?.url ?? '';
      const mimeType: string | undefined = e.response?.mimeType;
      if (isXcResourceApi(url) && isJsonMime(mimeType) && typeof e.requestId === 'string') {
        pendingApi.set(e.requestId, {
          tabId: source.tabId,
          url,
          status: e.response?.status ?? 0,
          resourceType: resourceTypeFromUrl(url),
          mimeType,
        });
      }
    }
  } else if (method === 'Network.loadingFinished') {
    // biome-ignore lint/suspicious/noExplicitAny: CDP event shape
    const e = eventParams as any;
    const pend = typeof e.requestId === 'string' ? pendingApi.get(e.requestId) : undefined;
    if (pend) {
      pendingApi.delete(e.requestId);
      const encoded: number = typeof e.encodedDataLength === 'number' ? e.encodedDataLength : 0;
      if (shouldFetchBody(pend.mimeType, encoded)) {
        chrome.debugger
          .sendCommand({ tabId: pend.tabId }, 'Network.getResponseBody', { requestId: e.requestId })
          .then((r) => {
            const body = (r as { body?: string })?.body;
            if (!body) return;
            try {
              latestApiCapture.set(pend.tabId, {
                url: pend.url,
                status: pend.status,
                resourceType: pend.resourceType,
                body: JSON.parse(body),
              });
            } catch {
              /* non-JSON despite mime — ignore */
            }
          })
          .catch(() => {
            /* body already evicted — degrade to no capture for this tab */
          });
      }
    }
  }
});

// --- MV3 keepalive ---------------------------------------------------------
//
// The service worker suspends after ~30s idle. Once suspended, only the ~30s
// reconnect alarm re-attaches it, so a fresh `xcsh` run that starts during a
// suspend window races (and loses to) that alarm → intermittent "extension did
// not connect" / hangs. Calling a chrome.* API on a sub-30s interval resets
// Chrome's idle timer, so the SW never suspends and is always ready to reconnect
// instantly. The call is cheap (one no-op API call every 20s) and self-sustaining
// once started; if Chrome ever hard-kills the SW it restarts on the next event.
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
function startKeepAlive(): void {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    // Any extension API call resets the idle timer. getPlatformInfo is trivial.
    chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);
  }, 20_000);
}

// Fast-reconnect: when the WebSocket closes (e.g. xcsh's bridge stopped, or no
// bridge was listening yet), retry on a fixed short interval. Because the SW is
// kept alive above, this keeps retrying so the extension re-attaches whenever a
// bridge next appears. WebSocket `onclose` drives reconnection; the timer is a
// single in-flight retry, coalesced so overlapping closes don't stack timers.
const RECONNECT_DELAY_MS = 1500;
let fastReconnectTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFastReconnect(): void {
  if (fastReconnectTimer) return;
  fastReconnectTimer = setTimeout(() => {
    fastReconnectTimer = null;
    if (ws?.readyState === WebSocket.OPEN) return;
    connect();
  }, RECONNECT_DELAY_MS);
}

function connect(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  try {
    const sock = new WebSocket(BRIDGE_URL);
    ws = sock;
    sock.onmessage = (ev) => onMessage(typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data);
    sock.onclose = () => {
      // Only clear the shared ref if this socket is still the current one, then
      // re-attach quickly so a newly-started bridge's probe finds us.
      if (ws === sock) ws = null;
      scheduleFastReconnect();
    };
    sock.onerror = () => {}; // onclose follows — reconnect is handled there.
  } catch {
    // WebSocket construction failed (e.g. bridge URL unreachable at startup).
    ws = null;
    scheduleFastReconnect();
  }
}

/** Send a JSON message to the bridge if the socket is open. */
function send(msg: unknown): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// biome-ignore lint/suspicious/noExplicitAny: bridge message shape
function onMessage(msg: any): void {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'ping') {
    send({ type: 'pong' });
    return;
  }

  if (msg.type === 'tool_request') {
    const { id, tool, params } = msg;
    runTool(tool, params)
      .then((content) => {
        send({ type: 'tool_result', id, content, is_error: false });
      })
      .catch((e) => {
        send({
          type: 'tool_result',
          id,
          content: String(e),
          is_error: true,
        });
      });
    return;
  }

  if (isChatInbound(msg)) {
    const port = turnToPort.get(msg.id);
    port?.postMessage(msg);
    // Only delete on genuinely terminal messages — chat_tool_notice is
    // non-terminal (more deltas/done/error follow), so deleting there would
    // orphan the turn and drop all subsequent messages.
    if (msg.type === 'chat_done' || msg.type === 'chat_error') turnToPort.delete(msg.id);
    return;
  }
}

// Keep the SW alive (so reconnection is always fast) and connect on startup.
// WebSocket `onclose` schedules a reconnect if the initial connect finds no
// bridge, so no explicit post-connect retry is needed here.
startKeepAlive();
connect();
// Open the side panel when the toolbar icon is clicked (requires an `action`
// with no default_popup in the manifest). Must run at top level — the SW restarts.
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});

// Read the managed enterprise policy on startup.
refreshManagedPolicy();

// Re-read the managed policy if enterprise policy changes at runtime.
chrome.storage.onChanged.addListener((_changes, areaName) => {
  if (areaName === 'managed') {
    refreshManagedPolicy();
  }
});

// Managed-policy refresh alarm (~5 min) — picks up policy pushes even if the
// onChanged event was missed while the SW was suspended.
chrome.alarms.create(MANAGED_POLICY_ALARM, { periodInMinutes: 5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === MANAGED_POLICY_ALARM) {
    refreshManagedPolicy();
  }
});

// --- Runtime messages from the options page + visual indicator -------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'status_request') {
    sendResponse({ connected: ws?.readyState === WebSocket.OPEN });
    return; // synchronous response
  }

  if (msg.type === 'stop_agent') {
    stopAgent();
    return;
  }
});

// --- Chat side panel Port --------------------------------------------------
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'xcsh-chat') return;
  port.onMessage.addListener((m) => {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'chat_request') {
      turnToPort.set(m.id, port);
      // Forward to the bridge as-is — buildChatRequest in the panel already
      // produces the correct shape (type 'chat_request', omitting history_hint
      // when absent). No reconstruction needed.
      send(m);
      return;
    }
    if (m.type === 'chat_stop') {
      // Forward stop to the bridge; do NOT delete the turn port — the bridge sends
      // a terminal chat_done/chat_error that the existing inbound routing handles.
      send({ type: 'chat_stop', id: m.id });
      return;
    }
    if (m.type === 'get_page_context') {
      buildPageContext()
        .then((snapshot) => port.postMessage({ type: 'page_context', snapshot }))
        .catch((e) => port.postMessage({ type: 'page_context_error', error: String(e) }));
      return;
    }
    if (m.type === 'chat_annotate') {
      chatAnnotate(m).catch(() => {});
      return;
    }
    if (m.type === 'status_request') {
      port.postMessage({ type: 'status', connected: ws?.readyState === WebSocket.OPEN });
      return;
    }
  });
  port.onDisconnect.addListener(() => {
    for (const [id, p] of turnToPort) if (p === port) turnToPort.delete(id);
  });
  // Greet with current connection status so the panel can render its dot.
  port.postMessage({ type: 'status', connected: ws?.readyState === WebSocket.OPEN });
});

/** Stop the agent: detach the debugger and hide the on-page indicator. */
function stopAgent(): void {
  if (targetTabId !== undefined) {
    detach().catch(() => {});
  }
  // Hide the visual indicator on all scoped console tabs.
  chrome.tabs.query({ url: SCOPED_QUERY_PATTERNS }).then((tabs) => {
    for (const tab of tabs) {
      if (tab.id !== undefined) {
        chrome.tabs.sendMessage(tab.id, { type: 'indicator_hide' }).catch(() => {});
      }
    }
  });
}

// --- Tool implementations --------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: Chrome extension API typings
async function runTool(tool: string, params: any): Promise<unknown> {
  // Pulse the on-page indicator while any non-trivial tool runs. `ping`,
  // `capabilities`, and `set_explain_mode` take no page action, so they stay silent.
  const broadcastsIndicator = tool !== 'ping' && tool !== 'capabilities' && tool !== 'set_explain_mode';
  if (broadcastsIndicator && targetTabId !== undefined) {
    chrome.tabs.sendMessage(targetTabId, { type: 'indicator_show' }).catch(() => {});
  }
  // Trivial tools excluded from the chat_tool_notice indicator.
  const excludedFromNotice =
    tool === 'ping' || tool === 'capabilities' || tool === 'set_explain_mode' || tool === 'get_page_context';
  let ok = true;
  try {
    const result = await dispatchTool(tool, params);
    return result;
  } catch (e) {
    ok = false;
    throw e;
  } finally {
    if (broadcastsIndicator && targetTabId !== undefined) {
      chrome.tabs.sendMessage(targetTabId, { type: 'indicator_hide' }).catch(() => {});
    }
    // Best-effort chat_tool_notice: if exactly one chat turn is active, notify its port.
    if (!excludedFromNotice && turnToPort.size === 1) {
      try {
        const [id, chatPort] = [...turnToPort.entries()][0];
        chatPort.postMessage({ type: 'chat_tool_notice', id, tool, ok });
      } catch {
        /* best-effort — never block dispatch on chat state */
      }
    }
  }
}

// Tool handlers, paired to the published descriptors in `capabilities.ts` by name.
// Dispatch runs through `runDispatch`, which validates params against the contract
// before invoking the handler — so the schema is load-bearing, not just docs.
// biome-ignore lint/suspicious/noExplicitAny: handlers receive contract-validated params
const TOOL_HANDLERS: Record<string, (params: any) => unknown | Promise<unknown>> = {
  ping: () => ({ ok: true, version: VERSION }),
  capabilities: () => buildCapabilities(VERSION),
  reload: () => {
    // Reload the extension (re-reads dist/ from disk); the SW restarts and the
    // WebSocket reconnects via connect() on startup.
    chrome.runtime.reload();
    return { reloading: true };
  },
  debug_exec: () => {
    // Diagnostic: test if __xcshReadAx is available via the debugger path.
    const tabId = requireTab();
    return evalInPage(tabId, '({ts:Date.now(),title:document.title,xcsh:typeof __xcshReadAx})');
  },
  navigate,
  login,
  select_option: selectOption,
  scroll_to: scrollTo,
  get_page_text: getPageText,
  javascript_tool: javascriptTool,
  tabs_list: tabsList,
  tabs_create: tabsCreate,
  tabs_close: tabsClose,
  resize_window: resizeWindow,
  read_console: readConsole,
  read_network: readNetwork,
  wait_for_api_response: waitForApiResponse,
  file_upload: fileUpload,
  browser_batch: browserBatch,
  read_ax: readAx,
  wait_for: waitFor,
  assert_text: assertText,
  find,
  click,
  click_element: clickElement,
  click_xy: clickXy,
  type_text: typeText,
  screenshot,
  form_input: formInput,
  key_press: keyPress,
  label_select: labelSelect,
  detach,
  set_explain_mode: setExplainMode,
  annotate,
  get_page_context: () => buildPageContext(),
};

// Fail fast (at SW load) if the dispatch map and the published contract diverge —
// a handler without a descriptor, or a described tool without a handler.
for (const name of Object.keys(TOOL_HANDLERS)) {
  if (!getToolDef(name)) throw new Error(`tool "${name}" has a handler but no descriptor in capabilities.ts`);
}
for (const name of toolNames()) {
  if (!(name in TOOL_HANDLERS)) throw new Error(`tool "${name}" is described but has no handler`);
}

function dispatchTool(tool: string, params: unknown): Promise<unknown> {
  return runDispatch(tool, params, TOOL_HANDLERS);
}

async function navigate(params: { url: string }): Promise<{ tabId: number }> {
  const url = params?.url;
  if (typeof url !== 'string' || !isScopedUrl(url)) {
    throw new Error(`navigate: url not in scoped console domains: ${url}`);
  }

  // Defense-in-depth (Phase 1 finding): only allow https. `isScopedUrl`
  // already enforces an https:// prefix, but validate the parsed scheme
  // explicitly so http:/file:/javascript:/data:/blob: can never slip through.
  let scheme: string;
  try {
    scheme = new URL(url).protocol;
  } catch {
    throw new Error(`navigate: invalid url: ${url}`);
  }
  if (scheme !== 'https:') {
    throw new Error(`navigate: only https: urls are allowed, got ${scheme}`);
  }

  // Enterprise policy override: refuse URLs matching any blocked pattern,
  // even within otherwise-allowed console domains.
  if (isBlockedUrl(url)) {
    throw new Error(`navigate: url blocked by managed policy: ${url}`);
  }

  // REUSE one console tab — do NOT close/recreate. Repeatedly creating fresh
  // tabs churns the OIDC session (causing "Invalid CSRF token") and forces a
  // new chrome.debugger attach (the "started debugging" infobar) each time.
  // Since reads go through CDP (not a content script), a stable single tab is
  // both correct and far gentler on the auth flow.
  let reuseId: number | undefined;
  if (targetTabId !== undefined) {
    try {
      const t = await chrome.tabs.get(targetTabId);
      if (t.id !== undefined) reuseId = t.id;
    } catch {
      /* prior tab was closed */
    }
  }
  if (reuseId === undefined) {
    const existing = await chrome.tabs.query({ url: SCOPED_QUERY_PATTERNS });
    if (existing.length > 0 && existing[0].id !== undefined) reuseId = existing[0].id;
  }

  let tabId: number;
  if (reuseId !== undefined) {
    targetTabId = reuseId;
    tabId = reuseId;

    // DEDUP: if the tab is already on the target URL, skip navigation entirely
    // (avoids re-triggering OIDC on an already-valid session → no CSRF).
    try {
      const current = await chrome.tabs.get(tabId);
      if (current.url && current.url.split('?')[0] === url.split('?')[0]) {
        // Content script injects via the manifest on page load (world:"MAIN").
        // Do NOT re-inject via executeScript — it HANGS the SW on the heavy XC SPA.
        return { tabId };
      }
    } catch {
      /* tab may be closed — proceed to create */
    }

    // Use CDP Page.navigate (NOT chrome.tabs.update) — programmatic CDP
    // navigations bypass the native beforeunload prompt entirely, so the
    // "Leave site?" dialog never fires regardless of the form's dirty state.
    // Neutralize beforeunload BEFORE navigating — covers both CDP and fallback paths.
    await neutralizeBeforeunload(tabId);
    try {
      await ensureDebuggerAttached(tabId);
      await chrome.debugger.sendCommand({ tabId }, 'Page.navigate', { url });
    } catch {
      // Fallback: debugger may not attach on some pages (chrome://, etc.)
      // neutralizeBeforeunload already ran, so the fallback tabs.update won't
      // trigger "Leave site?" even though it's a plain navigation.
      await chrome.tabs.update(tabId, { url, active: true });
    }
  } else {
    const created = await chrome.tabs.create({ url, active: true });
    if (created.id === undefined) {
      throw new Error('navigate: failed to create console tab');
    }
    targetTabId = created.id;
    tabId = created.id;
  }

  // Wait for navigation to complete on the new tab (race with a timeout).
  await waitForNavigation(tabId);

  // F5 XC sometimes returns "Invalid CSRF token" on an OIDC re-auth — a reload
  // restarts the flow with a fresh CSRF/state and recovers.
  await recoverFromCsrf(tabId);

  // The XC console is a heavy Angular SPA — webNavigation.onCompleted fires on
  // the initial HTML, long before the app renders its content. Wait for the DOM
  // to settle so read_ax/find see the real content, not the loading shell.
  await waitForSettle(tabId);

  // Session-expiry auto-recovery
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url && isKeycloakLoginUrl(tab.url) && lastLoginCredentials && !loginInProgress) {
      await login(lastLoginCredentials);
      await neutralizeBeforeunload(tabId);
      try {
        await ensureDebuggerAttached(tabId);
        await chrome.debugger.sendCommand({ tabId }, 'Page.navigate', { url });
      } catch {
        await chrome.tabs.update(tabId, { url, active: true });
      }
      await waitForNavigation(tabId);
      await waitForSettle(tabId);
    }
  } catch {
    /* best-effort recovery */
  }

  return { tabId };
}

/**
 * Detect F5 XC's "Invalid CSRF token" OIDC error and recover by reloading the
 * tab (which restarts the OIDC flow with a fresh CSRF/state).
 */
async function recoverFromCsrf(tabId: number): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let isCsrf = false;
    try {
      // Use executeScript (no debugger — debugger can freeze the SW on this page).
      const [r] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => /invalid csrf token|csrf token/i.test((document.body?.innerText || '').slice(0, 500)),
      });
      isCsrf = r?.result === true;
    } catch {
      return; // mid-navigation — let the caller's settle handle it
    }
    if (!isCsrf) return;
    await neutralizeBeforeunload(tabId);
    await chrome.tabs.reload(tabId);
    await waitForNavigation(tabId);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/**
 * Wait for the XC Angular SPA to finish rendering: poll the DOM element count
 * until it is non-trivial and stable across several polls, or a timeout. This
 * is what makes navigate → read_ax deterministic on the SPA.
 */
async function waitForSettle(tabId: number, timeoutMs = 15_000): Promise<void> {
  // Use executeScript (NOT chrome.debugger — the debugger can freeze the MV3 SW
  // on the heavy XC SPA) to poll the DOM element count until it stabilizes.
  let last = -1;
  let stable = 0;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && stable < 3) {
    let count = 0;
    try {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => document.querySelectorAll('*').length,
      });
      count = (r?.result as number) ?? 0;
    } catch {
      /* navigation in progress — retry */
    }
    if (count > 50 && count === last) stable++;
    else stable = 0;
    last = count;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * Native F5 XC login — drives the OIDC/Keycloak flow end-to-end.
 *
 * The XC console is OIDC-protected: visiting it 302-redirects to a Keycloak
 * realm login page, the user authenticates, Keycloak 302-redirects back with an
 * authorization code, and the console exchanges it for a session. This tool
 * navigates to the console, fills + submits the Keycloak form, handles the
 * optional `login-actions/required-action` interstitial, and waits until the
 * browser is back on a console (non-login) URL. Each stage is recorded in
 * `steps` so the AI engine (xcsh) has a systematic map of the redirect flow.
 *
 * Credentials are used in-memory only (passed per call from xcsh); they are
 * never persisted by the extension.
 */
async function login(params: {
  email: string;
  password: string;
  consoleUrl: string;
}): Promise<{ loggedIn: boolean; finalUrl: string; steps: string[] }> {
  // biome-ignore lint/suspicious/noExplicitAny: Chrome extension API typings
  const { email, password, consoleUrl } = params ?? ({} as any);
  if (!email || !password || !consoleUrl) {
    throw new Error('login: email, password, and consoleUrl are required');
  }
  // Cache creds for session-expiry auto-recovery (in-memory only, never persisted).
  lastLoginCredentials = { email, password, consoleUrl };
  // Only the console domain is a valid login target — reject anything else so
  // credentials can never be navigated to / injected into a foreign host.
  try {
    const parsed = new URL(consoleUrl);
    if (parsed.protocol !== 'https:' || !isScopedUrl(consoleUrl)) {
      throw new Error('not a console URL');
    }
  } catch {
    throw new Error(`login: consoleUrl is not a valid F5 XC console URL: ${consoleUrl}`);
  }

  const steps: string[] = [];
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // Use the module-scoped Keycloak login URL check (hostname-anchored) so
  // credentials are only ever injected into the genuine Keycloak/console
  // domains, never a foreign host that merely contains "/auth/realms/".
  const isLoginUrl = isKeycloakLoginUrl;

  // 1) Navigate to the console — 302s to Keycloak (or loads if already authed).
  //    Guard navigate()'s auto-recovery from re-entering login() (infinite
  //    login→navigate→recovery→login recursion) while this initial navigate runs.
  loginInProgress = true;
  let tabId: number;
  try {
    ({ tabId } = await navigate({ url: consoleUrl }));
  } finally {
    loginInProgress = false;
  }
  steps.push(`navigate → ${consoleUrl}`);

  // 2) Detect whether we're on the Keycloak login form or already on the console.
  const detectDeadline = Date.now() + 30_000;
  let onLoginForm = false;
  while (Date.now() < detectDeadline) {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url ?? '';
    if (isLoginUrl(url)) {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => ({
          form: !!document.querySelector('#username, #password'),
          invalid: /invalid username or password/i.test(document.body?.innerText ?? ''),
          href: location.href,
        }),
      });
      const res = r?.result as { form?: boolean; invalid?: boolean } | undefined;
      if (res?.form) {
        steps.push(`302 → Keycloak login page (${new URL(url).hostname})`);
        onLoginForm = true;
        break;
      }
    } else if (isScopedUrl(url) && !url.includes('code=') && !url.includes('state=')) {
      // Scoped URL without OIDC callback params → genuinely authenticated.
      // (If ?code=&state= are present, the OIDC exchange is still in-flight.)
      steps.push('already authenticated — console loaded');
      await waitForSettle(tabId);
      return { loggedIn: true, finalUrl: (await chrome.tabs.get(tabId)).url ?? url, steps };
    }
    await sleep(800);
  }
  if (!onLoginForm) {
    throw new Error('login: Keycloak login form did not appear within 30s');
  }

  // 3) Fill + submit the Keycloak credentials form.
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (em: string, pw: string) => {
      const u = document.querySelector("#username, input[name='username']") as HTMLInputElement | null;
      const p = document.querySelector("#password, input[name='password']") as HTMLInputElement | null;
      if (u) {
        u.value = em;
        u.dispatchEvent(new Event('input', { bubbles: true }));
        u.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (p) {
        p.value = pw;
        p.dispatchEvent(new Event('input', { bubbles: true }));
        p.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const btn = document.querySelector(
        "#kc-login, button[type='submit'], input[type='submit']",
      ) as HTMLElement | null;
      btn?.click();
    },
    args: [email, password],
  });
  steps.push('submitted credentials → #kc-login');

  // 4) Wait for the redirect back to the console, handling the required-action
  //    interstitial (e.g. UPDATE_PROFILE) and detecting invalid credentials.
  const authDeadline = Date.now() + 40_000;
  while (Date.now() < authDeadline) {
    await sleep(1000);
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url ?? '';

    if (isScopedUrl(url) && !isLoginUrl(url)) {
      steps.push(`302 → console (${new URL(url).hostname}) — authenticated`);
      await recoverFromCsrf(tabId); // /web can land on an Invalid CSRF token page
      await waitForSettle(tabId); // let the console SPA render before returning
      return { loggedIn: true, finalUrl: (await chrome.tabs.get(tabId)).url ?? url, steps };
    }

    // Still on a Keycloak page — check for an error or a required-action form.
    if (isLoginUrl(url)) {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const invalid = /invalid username or password|account is disabled/i.test(document.body?.innerText ?? '');
          if (invalid) return 'invalid';
          // Required-action discrimination: read the execution= type and handle
          // each differently. Safe actions auto-submit; dangerous ones throw clear errors.
          const isInterstitial = /required-action|login-actions\/(authenticate|action-token)/.test(location.pathname);
          if (!isInterstitial) return 'waiting';

          // Detect MFA / TOTP prompt
          const hasOtp = !!document.querySelector("#otp, input[name='totp'], input[name='otp']");
          if (hasOtp) return 'mfa-required';

          // Read the execution= parameter to determine the action type
          const execParam = new URLSearchParams(location.search).get('execution') ?? '';
          const execType = execParam.toUpperCase();

          // Password change / email verify require user input — can't auto-submit
          if (execType.includes('PASSWORD')) return 'password-change-required';
          if (execType.includes('VERIFY_EMAIL')) return 'email-verification-required';
          if (execType.includes('CONFIGURE_TOTP')) return 'totp-setup-required';

          // UPDATE_PROFILE and other safe actions — auto-submit
          const submit = document.querySelector(
            "input[type='submit'], button[type='submit'], #kc-login",
          ) as HTMLElement | null;
          if (submit) {
            submit.click();
            return `interstitial-submitted:${execType}`;
          }
          return 'waiting';
        },
      });
      const state = (r?.result as string) ?? '';
      if (state === 'invalid') {
        throw new Error('login: invalid username or password');
      }
      if (state === 'mfa-required') {
        throw new Error(
          'login: MFA TOTP code required — either set F5XC_TOTP_SECRET in your xcsh context or complete the 2FA prompt in the visible Chrome window',
        );
      }
      if (state === 'password-change-required') {
        throw new Error(
          'login: password change required — update your password in the visible Chrome window, then retry',
        );
      }
      if (state === 'email-verification-required') {
        throw new Error('login: email verification required — check your email, then retry');
      }
      if (state === 'totp-setup-required') {
        throw new Error('login: MFA TOTP setup required — complete the setup in the visible Chrome window, then retry');
      }
      if (state.startsWith('interstitial-submitted')) {
        steps.push(`handled Keycloak required-action interstitial (${state.split(':')[1] ?? ''})`);
      }
    }
  }

  const finalTab = await chrome.tabs.get(tabId);
  throw new Error(`login: did not reach the console within 40s (stuck on ${finalTab.url?.slice(0, 70)})`);
}

function waitForNavigation(tabId: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;

    const onCompleted = (details: chrome.webNavigation.WebNavigationFramedCallbackDetails) => {
      // Only the top-level frame of the target tab.
      if (details.tabId === tabId && details.frameId === 0) {
        finish();
      }
    };

    const timer = setTimeout(finish, NAV_TIMEOUT_MS);

    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.webNavigation.onCompleted.removeListener(onCompleted);
      resolve();
    }

    chrome.webNavigation.onCompleted.addListener(onCompleted);
  });
}

function requireTab(): number {
  if (targetTabId === undefined) {
    throw new Error('no target tab — call navigate first');
  }
  return targetTabId;
}

/**
 * Evaluate a JS expression in the page's MAIN world via chrome.debugger
 * Runtime.evaluate. This is the ONLY reliable way to reach the content-script's
 * __xcsh* globals on the heavy XC SPA — chrome.scripting.executeScript hangs
 * (30s+) while Runtime.evaluate returns in <20ms on the same page.
 */
async function evalInPage<T>(tabId: number, expression: string): Promise<T> {
  await ensureDebuggerAttached(tabId);
  const r = (await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: false,
  })) as { result?: { value?: T }; exceptionDetails?: { text?: string } };
  if (r.exceptionDetails) {
    throw new Error(`evalInPage error: ${r.exceptionDetails.text ?? 'unknown'}`);
  }
  return r.result?.value as T;
}

/**
 * Evaluate an expression and return a live OBJECT HANDLE (objectId) to its result
 * instead of a serialized value — the element-handle counterpart to {@link evalInPage}.
 * Returns undefined when the expression yields null/undefined (no element).
 * The caller MUST release the handle (Runtime.releaseObject) — clickElementByObjectId does.
 */
async function evalForObject(tabId: number, expression: string): Promise<string | undefined> {
  await ensureDebuggerAttached(tabId);
  const r = (await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression,
    returnByValue: false,
    awaitPromise: false,
  })) as { result?: { objectId?: string; subtype?: string }; exceptionDetails?: { text?: string } };
  if (r.exceptionDetails) {
    throw new Error(`evalForObject error: ${r.exceptionDetails.text ?? 'unknown'}`);
  }
  // subtype 'null' or no objectId → the expression returned null/undefined.
  if (!r.result?.objectId || r.result.subtype === 'null') return undefined;
  return r.result.objectId;
}

/**
 * THE deterministic click primitive. Given a live element handle (objectId), it
 * derives the clickable point from the RENDERER's layout (DOM.getContentQuads —
 * CSS viewport px, transforms/zoom/DPR already baked in, the exact space
 * Input.dispatchMouseEvent consumes) rather than JS getBoundingClientRect, then
 * VERIFIES the point lands on the target via document.elementFromPoint before
 * dispatching. The handle is held across scroll→measure→verify→click so coords
 * can't go stale. On occlusion it re-scrolls once, then fails loudly naming the
 * occluder — never a silent mis-click. Releases the handle in finally.
 */
async function clickElementByObjectId(
  tabId: number,
  objectId: string,
  label = 'element',
): Promise<{ x: number; y: number; hit: boolean }> {
  const T = { tabId };
  try {
    // Center of the largest visible content quad; fall back to the box model.
    const measure = async (): Promise<{ x: number; y: number }> => {
      try {
        await chrome.debugger.sendCommand(T, 'DOM.scrollIntoViewIfNeeded', { objectId });
      } catch {
        /* some nodes can't scroll; geometry may still be valid */
      }
      const quadsRes = (await chrome.debugger
        .sendCommand(T, 'DOM.getContentQuads', { objectId })
        .catch(() => ({ quads: [] }))) as { quads: number[][] };
      let best: number[] | undefined;
      let bestArea = 0;
      for (const q of quadsRes.quads ?? []) {
        // Shoelace area of the 4-point quad [x1,y1,x2,y2,x3,y3,x4,y4].
        const a =
          Math.abs(
            q[0] * q[3] -
              q[2] * q[1] +
              (q[2] * q[5] - q[4] * q[3]) +
              (q[4] * q[7] - q[6] * q[5]) +
              (q[6] * q[1] - q[0] * q[7]),
          ) / 2;
        if (a > bestArea) {
          bestArea = a;
          best = q;
        }
      }
      if (best && bestArea > 1) {
        return { x: (best[0] + best[4]) / 2, y: (best[1] + best[5]) / 2 };
      }
      // Fallback: box model content quad (handles zero-area-quad-but-clickable cases).
      const bm = (await chrome.debugger.sendCommand(T, 'DOM.getBoxModel', { objectId })) as {
        model: { content: number[] };
      };
      const c = bm.model.content;
      return { x: (c[0] + c[4]) / 2, y: (c[1] + c[5]) / 2 };
    };

    // Hit-test: does the point resolve to the target (self / ancestor / descendant)?
    const hitTest = async (x: number, y: number): Promise<string> => {
      const res = (await chrome.debugger.sendCommand(T, 'Runtime.callFunctionOn', {
        objectId,
        returnByValue: true,
        functionDeclaration: `function(cx, cy){
          var h = document.elementFromPoint(cx, cy);
          if (!h) return 'none';
          if (h === this || this.contains(h) || h.contains(this)) return 'hit';
          return 'occluded:' + (h.tagName||'') + '.' + ((h.className||'')+'').slice(0,40);
        }`,
        arguments: [{ value: x }, { value: y }],
      })) as { result?: { value?: string } };
      return res.result?.value ?? 'none';
    };

    let { x, y } = await measure();
    let verdict = await hitTest(x, y);
    if (verdict !== 'hit') {
      // Scroll-retry once: the target may have been mid-animation or just-scrolled.
      try {
        await chrome.debugger.sendCommand(T, 'DOM.scrollIntoViewIfNeeded', { objectId });
      } catch {
        /* best-effort */
      }
      await new Promise((r) => setTimeout(r, 150));
      ({ x, y } = await measure());
      verdict = await hitTest(x, y);
    }
    if (verdict !== 'hit') {
      throw new Error(`click: "${label}" not hittable — point (${Math.round(x)},${Math.round(y)}) ${verdict}`);
    }

    await dispatchClickAt(tabId, x, y);
    return { x, y, hit: true };
  } finally {
    await chrome.debugger.sendCommand(T, 'Runtime.releaseObject', { objectId }).catch(() => {});
  }
}

/**
 * Neutralize ALL beforeunload handlers on the current page so "Leave site?"
 * never fires. Called before EVERY navigation (tabs.update, tabs.reload,
 * Page.navigate) and before tabs.remove (close).
 *
 * Strategy: try the debugger (evalInPage, MAIN world) first — it's fast and
 * works on the heavy XC SPA. If the debugger can't attach (chrome:// pages,
 * login pages), fall back to chrome.scripting.executeScript with world:"MAIN"
 * (works on light pages; hangs on the heavy XC SPA — but the fallback only
 * fires when the debugger can't attach, which means a non-XC page).
 *
 * The neutralization removes the onbeforeunload property AND overrides
 * addEventListener to drop future beforeunload registrations (the XC Angular
 * SPA re-registers its dirty-form guard dynamically).
 */
async function neutralizeBeforeunload(tabId: number): Promise<void> {
  const js = `
    window.onbeforeunload = null;
    if (!window.__xcshBuNeutralized) {
      window.__xcshBuNeutralized = true;
      const origAdd = EventTarget.prototype.addEventListener;
      EventTarget.prototype.addEventListener = function(type, ...args) {
        if (type === 'beforeunload') return;
        return origAdd.call(this, type, ...args);
      };
      Object.defineProperty(window, 'onbeforeunload', {
        set() {}, get() { return null; }, configurable: true
      });
    }
    'neutralized'
  `;
  try {
    // Prefer the debugger (MAIN world, fast, works on XC SPA).
    await evalInPage<string>(tabId, js);
  } catch {
    // Fallback: executeScript (works on light pages where debugger can't attach).
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        // biome-ignore lint/suspicious/noExplicitAny: Chrome API
        world: 'MAIN' as any,
        func: () => {
          window.onbeforeunload = null;
          // biome-ignore lint/suspicious/noExplicitAny: Chrome API
          if (!(window as any).__xcshBuNeutralized) {
            // biome-ignore lint/suspicious/noExplicitAny: Chrome API
            (window as any).__xcshBuNeutralized = true;
            const origAdd = EventTarget.prototype.addEventListener;
            // biome-ignore lint/suspicious/noExplicitAny: Chrome API
            EventTarget.prototype.addEventListener = function (type: string, ...args: any[]) {
              if (type === 'beforeunload') return;
              return Reflect.apply(origAdd, this, [type, ...args]);
            };
            Object.defineProperty(window, 'onbeforeunload', {
              set() {},
              get() {
                return null;
              },
              configurable: true,
            });
          }
        },
      });
    } catch {
      // Neither debugger nor executeScript worked — the page may not be scriptable
      // (chrome://, about:blank). beforeunload may fire, but these pages rarely
      // have dirty forms. Accept the risk.
    }
  }
}

/** Run `__xcshReadAx()` in the target tab and return the AX tree. */
async function readAxFromTab(): Promise<AxNode> {
  const tabId = requireTab();
  // chrome.scripting.executeScript HANGS on the heavy XC SPA (confirmed: 30s+
  // timeout while chrome.debugger Runtime.evaluate returns in 13ms on the same
  // page). Route ALL page reads through the debugger instead.
  // First: inject the serializeAx code via Runtime.evaluate if __xcshReadAx
  // isn't available (content script may not have injected on this page load).
  await ensureDebuggerAttached(tabId);
  // If __xcshReadAx isn't defined (extension reloaded / content script not yet
  // injected on this page), inject it inline via Runtime.evaluate. This is the
  // same IIFE the manifest's content_scripts would inject on a new page load.
  const isAvailable = await evalInPage<boolean>(tabId, "typeof __xcshReadAx === 'function'");
  if (!isAvailable) {
    // Fetch the built content script and inject it via the debugger (Runtime.evaluate).
    // fetch() works in the SW context against the extension's own files.
    const code = await (await fetch(chrome.runtime.getURL('accessibility-tree.js'))).text();
    await evalInPage<void>(tabId, code);
  }

  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const r = (await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: "typeof __xcshReadAx === 'function' ? JSON.stringify(__xcshReadAx()) : null",
        returnByValue: true,
      })) as { result?: { value?: string | null } };
      const json = r?.result?.value;
      if (json) {
        const tree = JSON.parse(json);
        if (tree && typeof tree === 'object' && 'role' in (tree as object)) return tree as AxNode;
      }
    } catch {
      /* page still loading / navigating — retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('read_ax: __xcshReadAx not available via debugger (page may still be loading)');
}

async function readAx(): Promise<unknown> {
  return readAxFromTab();
}

async function waitFor(params: {
  selector: string;
  context?: string;
  timeoutMs?: number;
}): Promise<{ found: true; ref: string }> {
  // TODO: context scoping — `context` is ignored in Phase 1; a plain matchNode
  // suffices. Phase 2 adds scoped resolution via findSectionContainer.
  const selector = params?.selector;
  const timeoutMs = params?.timeoutMs ?? 30_000;
  const loc = parseLocator(selector);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tree = await readAxFromTab();
    try {
      const node = matchNode(tree, loc);
      return { found: true, ref: node.ref as string };
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`wait_for "${selector}" timed out after ${timeoutMs}ms`);
}

async function assertText(params: {
  selector: string;
  expected: string;
  context?: string;
}): Promise<{ asserted: true; text: string }> {
  // TODO: context scoping — `context` is ignored in Phase 1.
  const tabId = requireTab();
  const { selector, expected } = params;
  const tree = await readAxFromTab();
  const node = matchNode(tree, parseLocator(selector));
  // The matched AX node's accessible name often already contains the text;
  // fall back to the element's innerText (content script) for a full check.
  let text = (node.name as string) ?? '';
  if (!text.includes(expected) && node.ref) {
    text = await evalInPage<string>(
      tabId,
      `typeof __xcshGetInnerText==='function'?__xcshGetInnerText(${JSON.stringify(node.ref)}):''`,
    );
  }
  if (!text.includes(expected)) {
    throw new Error(`assert failed: "${expected}" not in "${text.slice(0, 200)}"`);
  }
  return { asserted: true, text: text.slice(0, 200) };
}

async function find(params: {
  selector: string;
}): Promise<{ refs: Array<{ ref: string; role: string; name: string }> }> {
  const { selector } = params;
  const tree = await readAxFromTab();
  const nodes = matchNodes(tree, parseLocator(selector));
  return {
    refs: nodes.slice(0, 20).map((n) => ({
      ref: n.ref as string,
      role: n.role,
      name: (n.name as string) ?? '',
    })),
  };
}

/** Dispatch a trusted left click at viewport coords via the debugger. Trusted
 * (not synthetic) events are required for Angular-zone handlers (e.g. vsui
 * dropdowns / form submit buttons) to fire and run change detection. */
async function dispatchClickAt(tabId: number, x: number, y: number): Promise<void> {
  // Visual cue BEFORE the click — the fingerprint must bloom before the click
  // could dismiss a dialog/window (the overlay needs time to render, and if the
  // click navigates or closes a panel, a post-click overlay may never show).
  // Only during a deliberate "explain" walkthrough; best-effort (the content
  // script may not be present yet, e.g. mid-navigation).
  if (explainMode) {
    chrome.tabs.sendMessage(tabId, { type: 'overlay', kind: 'fingerprint', x, y }).catch(() => {});
  }
  // Move the pointer over the target first — some controls (Angular Material /
  // vsui buttons) only react once they see a hover/pointer-position update.
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y,
  });
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: 1,
  });
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: 1,
  });
}

/** Enter/leave explain mode (the gate for all on-page annotation overlays). */
function setExplainMode(params: { enabled?: boolean }): { enabled: boolean } {
  explainMode = !!params?.enabled;
  return { enabled: explainMode };
}

/** Build the page-context snapshot for the active console tab. */
async function buildPageContext(): Promise<unknown> {
  const tabId = requireTab();
  await enableNetworkObserver(); // ensure future navigations are captured
  let url = '';
  let title = '';
  try {
    const tab = await chrome.tabs.get(tabId);
    url = tab.url ?? '';
    title = tab.title ?? '';
  } catch {
    /* tab vanished — fall through with empties */
  }
  let ax: AxLike | null = null;
  try {
    ax = (await readAxFromTab()) as unknown as AxLike;
  } catch {
    /* page still loading — snapshot without ax */
  }
  const api = latestApiCapture.get(tabId) ?? null;
  return buildContextSnapshot({ tabId, url, title, capturedAt: Date.now(), ax, api });
}

/**
 * Draw an annotation for the chat/teaching path — like `annotate` but NOT gated
 * by explain mode, because a chat-initiated highlight is an explicit, user-facing
 * request. The fast-automation `annotate` tool keeps its "off by default" gate.
 */
async function chatAnnotate(spec: {
  kind?: string;
  ref?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}): Promise<void> {
  if (targetTabId === undefined) return;
  const tabId = targetTabId;
  const kind = spec.kind ?? 'highlight';
  if (kind === 'highlight') {
    let rect: { x: number; y: number; w: number; h: number } | undefined;
    if ([spec.x, spec.y, spec.w, spec.h].every((n) => Number.isFinite(Number(n)))) {
      rect = { x: Number(spec.x), y: Number(spec.y), w: Number(spec.w), h: Number(spec.h) };
    } else if (spec.ref) {
      rect = await resolveRectByRef(tabId, spec.ref);
    }
    if (rect) chrome.tabs.sendMessage(tabId, { type: 'overlay', kind: 'highlight', ...rect }).catch(() => {});
  } else if (kind === 'fingerprint' && Number.isFinite(Number(spec.x)) && Number.isFinite(Number(spec.y))) {
    chrome.tabs
      .sendMessage(tabId, { type: 'overlay', kind: 'fingerprint', x: Number(spec.x), y: Number(spec.y) })
      .catch(() => {});
  }
}

/**
 * Draw an overlay annotation on the target tab — the agent-callable side of the
 * overlay library. No-ops (returns `{ skipped }`) unless explain mode is on, so the
 * "off by default" rule holds even for explicit calls. `highlight` accepts either
 * an explicit rect or a `ref` we resolve to its border box here (the same ref the
 * agent uses to click); `fingerprint` takes a point.
 */
async function annotate(params: {
  kind?: string;
  ref?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}): Promise<unknown> {
  const kind = params?.kind;
  if (!kind) throw new Error('annotate: kind is required');
  if (!explainMode) return { skipped: true, reason: 'explain mode off' };
  const tabId = requireTab();

  if (kind === 'highlight') {
    let rect: { x: number; y: number; w: number; h: number } | undefined;
    if ([params.x, params.y, params.w, params.h].every((n) => Number.isFinite(Number(n)))) {
      rect = { x: Number(params.x), y: Number(params.y), w: Number(params.w), h: Number(params.h) };
    } else if (params.ref) {
      rect = await resolveRectByRef(tabId, params.ref);
    }
    if (!rect) throw new Error('annotate: highlight needs numeric x/y/w/h or a resolvable ref');
    chrome.tabs.sendMessage(tabId, { type: 'overlay', kind: 'highlight', ...rect }).catch(() => {});
    return { drawn: 'highlight', ...rect };
  }

  if (kind === 'fingerprint') {
    const x = Number(params.x);
    const y = Number(params.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('annotate: fingerprint needs numeric x,y');
    chrome.tabs.sendMessage(tabId, { type: 'overlay', kind: 'fingerprint', x, y }).catch(() => {});
    return { drawn: 'fingerprint', x, y };
  }

  throw new Error(`annotate: unknown kind: ${kind}`);
}

/**
 * Resolve a read_ax ref to its border-box rect (CSS viewport px) via the live
 * element handle + CDP box model — the same resolver path `click` uses.
 */
async function resolveRectByRef(
  tabId: number,
  ref: string,
): Promise<{ x: number; y: number; w: number; h: number } | undefined> {
  await ensureDebuggerAttached(tabId);
  const objectId = await evalForObject(
    tabId,
    `(typeof __xcshResolveRefEl === 'function' ? __xcshResolveRefEl(${JSON.stringify(ref)}) : null)`,
  );
  if (!objectId) return undefined;
  try {
    await chrome.debugger.sendCommand({ tabId }, 'DOM.scrollIntoViewIfNeeded', { objectId }).catch(() => {});
    const bm = (await chrome.debugger.sendCommand({ tabId }, 'DOM.getBoxModel', { objectId })) as {
      model?: { border?: number[] };
    };
    const b = bm.model?.border;
    if (!b || b.length < 8) return undefined;
    // border quad: [x1,y1, x2,y2, x3,y3, x4,y4] (TL, TR, BR, BL) in CSS px.
    const xs = [b[0], b[2], b[4], b[6]];
    const ys = [b[1], b[3], b[5], b[7]];
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  } finally {
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.releaseObject', { objectId }).catch(() => {});
  }
}

async function click(params: { ref: string }): Promise<{ clicked: string; x: number; y: number }> {
  const tabId = requireTab();
  const ref = params?.ref;
  if (!ref) throw new Error('click: ref is required');
  // Resolve the ref → live element handle, then click via the deterministic
  // layout-engine + hit-test path (geometry from getContentQuads, not JS rects).
  const objectId = await evalForObject(
    tabId,
    `(typeof __xcshResolveRefEl === 'function' ? __xcshResolveRefEl(${JSON.stringify(ref)}) : null)`,
  );
  if (!objectId) throw new Error(`click: could not resolve ref: ${ref}`);
  const { x, y } = await clickElementByObjectId(tabId, objectId, `ref ${ref}`);
  return { clicked: ref, x, y };
}

/** Deterministic click by selector-resolver JS. The caller passes an expression
 * that returns an Element (or null) — e.g. xcsh's element-returning resolver for
 * role selectors, or a portal-option finder. We hold the element handle and click
 * via the layout-engine + hit-test path. `wait_ms` polls for the element to appear
 * (CDK portals render async). Never silently mis-clicks: occlusion fails loudly. */
async function clickElement(params: {
  js: string;
  wait_ms?: number;
}): Promise<{ clicked: string; x: number; y: number; hit: boolean }> {
  const tabId = requireTab();
  const js = params?.js;
  if (typeof js !== 'string' || js.length === 0) throw new Error('click_element: js is required');
  const waitMs = Math.min(Number(params?.wait_ms ?? 0), 20_000);
  await ensureDebuggerAttached(tabId);
  const deadline = Date.now() + waitMs;
  let objectId = await evalForObject(tabId, js);
  while (!objectId && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    objectId = await evalForObject(tabId, js);
  }
  if (!objectId) throw new Error(`click_element: expression matched no element`);
  const { x, y, hit } = await clickElementByObjectId(tabId, objectId, 'element');
  return { clicked: 'element', x, y, hit };
}

/** Trusted click at explicit viewport coordinates. Lets callers act on elements
 * located via `javascript_tool` (getBoundingClientRect) WITHOUT a `read_ax` ref
 * — essential on heavy pages (e.g. the create form) where read_ax cannot run. */
async function clickXy(params: { x: number; y: number }): Promise<{ clicked: string; x: number; y: number }> {
  const tabId = requireTab();
  const x = Number(params?.x);
  const y = Number(params?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('click_xy: numeric x and y are required');
  await dispatchClickAt(tabId, x, y);
  return { clicked: `${x},${y}`, x, y };
}

/** Type text into the focused element via CDP Input.insertText. Unlike setting
 * `.value`, this fires genuine trusted `input` events, so Angular's
 * ControlValueAccessor commits the value to the reactive form model — the
 * authentic "human typing" path, robust to vsui value-descriptor patching. */
async function typeText(params: { text: string }): Promise<{ typed: string }> {
  const tabId = requireTab();
  const text = params?.text;
  if (typeof text !== 'string') throw new Error('type_text: text is required');
  await ensureDebuggerAttached(tabId);
  await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text });
  return { typed: text };
}

/** Atomically type into a CDK-portal typeahead, wait for the dropdown to render,
 * and click the matching option — all within ONE handler so the input stays focused
 * throughout. The root cause of previous failures was `javascript_tool` routing
 * through `evaluateWithRecovery`, which detaches/reattaches the debugger and kills
 * input focus, closing the CDK portal. Here we ONLY use plain `evalInPage`
 * (Runtime.evaluate, no detach) and trusted `Input.*` CDP commands. */
async function labelSelect(params: {
  selector: string;
  value: string;
  label_value?: string;
  wait_ms?: number;
}): Promise<{ selected: string; matchedKind: string; value: string; labelValue: string; optionCount: number }> {
  const tabId = requireTab();
  const selector = params?.selector;
  const value = params?.value ?? '';
  const labelValue = params?.label_value ?? '';
  // Cap well below the 30s bridge timeout so the handler finishes before the caller times out.
  const waitMs = Math.min(Number(params?.wait_ms ?? 8_000), 20_000);
  if (typeof selector !== 'string' || selector.length === 0) throw new Error('label_select: selector is required');
  await ensureDebuggerAttached(tabId);

  // ── A. Locate the typeahead input and get its viewport coords. ──────────────
  // evalInPage (Runtime.evaluate) does NOT defocus — safe to call with the input focused.
  const selectorJson = JSON.stringify(selector);
  const inputCoords = await evalInPage<{ found: boolean; x: number; y: number }>(
    tabId,
    `(() => {
      const sel = ${selectorJson};
      let el = null;
      try { el = document.querySelector(sel); } catch {}
      if (!el) {
        el = [...document.querySelectorAll('input')].find(i =>
          (i.placeholder || '').includes('Type to search') ||
          (i.placeholder || '').includes('Select or Add Key'));
      }
      if (!el) return { found: false, x: 0, y: 0 };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { found: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`,
  );
  if (!inputCoords?.found) throw new Error(`label_select: input "${selector}" not found`);

  // ── B. Click the input (trusted CDP — keeps focus). ─────────────────────────
  await dispatchClickAt(tabId, inputCoords.x, inputCoords.y);

  // ── C. Small settle, then type (Input.insertText keeps focus). ───────────────
  await new Promise((r) => setTimeout(r, 300));
  await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text: value });

  // ── D. Poll the CDK portal for a matching option. ───────────────────────────
  // One evalInPage per poll iteration — returns match coords in the same round-trip
  // so we can click immediately (no second eval that might close the portal).
  const valueJson = JSON.stringify(value);
  const deadline = Date.now() + waitMs;
  let lastOptions: string[] = [];
  let matchResult: { matched: boolean; kind: string; text: string; x: number; y: number; optionCount: number } | null =
    null;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    const poll = await evalInPage<{
      portal: boolean;
      matched?: boolean;
      kind?: string;
      text?: string;
      x?: number;
      y?: number;
      optionCount?: number;
      options?: string[];
    }>(
      tabId,
      `(() => {
        const want = ${valueJson};
        const norm = t => (t || '').replace(/\\s+/g, ' ').trim();
        const container = document.querySelector('.cdk-overlay-container');
        if (!container) return { portal: false };
        // Collect all visible inline-text nodes from the portal that look like option labels.
        const spans = [...container.querySelectorAll('span, li, [role="option"]')].filter(e => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && norm(e.textContent).length > 0;
        });
        if (!spans.length) return { portal: true, options: [] };
        const texts = spans.map(e => norm(e.textContent));
        const w = want.toLowerCase();
        let kind = 'exact';
        let idx = texts.findIndex(t => t.toLowerCase() === w);
        if (idx < 0) { kind = 'startsWith'; idx = texts.findIndex(t => t.toLowerCase().startsWith(w)); }
        if (idx < 0) { kind = 'includes';   idx = texts.findIndex(t => t.toLowerCase().includes(w)); }
        if (idx < 0) { kind = 'custom';     idx = texts.findIndex(t => /assign a custom key/i.test(t)); }
        if (idx < 0) return { portal: true, matched: false, options: texts.slice(0, 10), optionCount: spans.length };
        const el = spans[idx];
        el.scrollIntoView({ block: 'center', inline: 'center' });
        // Tag the matched option so the deterministic click path can grab its
        // live element handle (geometry from getContentQuads + hit-test) instead
        // of clicking stale getBoundingClientRect coords.
        document.querySelectorAll('[data-xcsh-pick]').forEach(n => n.removeAttribute('data-xcsh-pick'));
        el.setAttribute('data-xcsh-pick', '1');
        const r = el.getBoundingClientRect();
        return {
          portal: true, matched: true, kind, text: texts[idx],
          x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
          optionCount: spans.length,
        };
      })()`,
    );

    if (!poll?.portal) continue; // portal not rendered yet — wait
    if (!poll.matched) {
      lastOptions = poll.options ?? [];
      continue; // portal rendered but no match yet — may still be filtering
    }
    matchResult = {
      matched: true,
      kind: poll.kind ?? 'unknown',
      text: poll.text ?? '',
      x: poll.x ?? 0,
      y: poll.y ?? 0,
      optionCount: poll.optionCount ?? 0,
    };
    break;
  }

  if (!matchResult) {
    const opts = lastOptions.length ? ` (saw: ${lastOptions.slice(0, 8).join(', ')})` : ' (portal never rendered)';
    throw new Error(`label_select: no option matching "${value}" within ${waitMs}ms${opts}`);
  }

  // ── E. Click the option via the deterministic path (layout-engine coords +
  // hit-test). Grab the tagged option's live handle; if the portal occludes it
  // the hit-test fails loudly rather than mis-clicking. ────────────────────────
  const optObj = await evalForObject(tabId, `document.querySelector('[data-xcsh-pick]')`);
  if (optObj) {
    await clickElementByObjectId(tabId, optObj, `option "${matchResult.text}"`);
  } else {
    // Tag lost (portal re-rendered) — fall back to the confirmed coords.
    await dispatchClickAt(tabId, matchResult.x, matchResult.y);
  }
  await evalInPage(
    tabId,
    `document.querySelectorAll('[data-xcsh-pick]').forEach(n=>n.removeAttribute('data-xcsh-pick'))`,
  ).catch(() => {});

  // ── F. After selecting a key, a VALUE input appears. Type the value + Enter. ──
  // This commits the key=value label pair. Multiple labels can be added by calling
  // label_select again (each call = one key+value).
  if (labelValue) {
    await new Promise((r) => setTimeout(r, 1500));
    // Find the value input that appeared after key selection
    const valInput = await evalInPage<{ found: boolean; x: number; y: number }>(
      tabId,
      `(() => {
        // Look for a new input that appeared after the key selection
        // It's typically a text input near the label key, with placeholder containing "value" or "enter"
        const inputs = [...document.querySelectorAll('input')].filter(e => {
          const r = e.getBoundingClientRect();
          const ph = (e.placeholder || '').toLowerCase();
          return r.width > 0 && (ph.includes('value') || ph.includes('enter') || ph === '');
        });
        // The newest/last visible empty input is likely the value field
        const el = inputs.filter(e => !e.value).pop() || inputs.pop();
        if (!el) return { found: false, x: 0, y: 0 };
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return { found: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`,
    );
    if (valInput?.found) {
      await dispatchClickAt(tabId, valInput.x, valInput.y);
      await new Promise((r) => setTimeout(r, 200));
      await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text: labelValue });
      await new Promise((r) => setTimeout(r, 200));
      // Press Enter to commit the value
      const enterBase = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 };
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { type: 'keyDown', ...enterBase });
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { type: 'keyUp', ...enterBase });
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return {
    selected: matchResult.text,
    matchedKind: matchResult.kind,
    value,
    labelValue,
    optionCount: matchResult.optionCount,
  };
}

async function screenshot(): Promise<{ data: string; format: string }> {
  // captureVisibleTab freezes the MV3 service worker's event loop on this
  // 3024x1964 retina Mac (even q5), blocking ALL subsequent bridge requests.
  // Use the debugger's Runtime.evaluate to capture a downscaled canvas screenshot
  // instead — this runs in the page (no SW freeze) and produces a small JPEG.
  const tabId = requireTab();
  await ensureDebuggerAttached(tabId);
  const data = await evalInPage<string>(
    tabId,
    `
    (() => {
      try {
        const c = document.createElement('canvas');
        const w = Math.min(window.innerWidth, 1280);
        const h = Math.min(window.innerHeight, 800);
        const scale = Math.min(1, 600 / w); // downscale to ~600px wide
        c.width = Math.round(w * scale);
        c.height = Math.round(h * scale);
        const ctx = c.getContext('2d');
        // drawWindow is Firefox-only; for Chrome, return a placeholder.
        // The real screenshot needs html2canvas or a server-side capture.
        return 'SCREENSHOT_NOT_AVAILABLE_IN_PAGE_CONTEXT';
      } catch (e) { return 'error:' + e.message; }
    })()
  `,
  );
  if (data === 'SCREENSHOT_NOT_AVAILABLE_IN_PAGE_CONTEXT') {
    throw new Error(
      'screenshot: in-page canvas capture not supported in Chrome (captureVisibleTab freezes SW on this retina display; screenshot deferred to a future release)',
    );
  }
  return { data, format: 'jpeg' };
}

async function formInput(params: { ref: string; value: string }): Promise<{ filled: string; value: string }> {
  const tabId = requireTab();
  const ref = params?.ref;
  const value = params?.value;
  if (!ref) throw new Error('form_input: ref is required');
  // Commit the value via the debugger (executeScript hangs on the XC SPA).
  await evalInPage<void>(tabId, `__xcshCommitInputValue(${JSON.stringify(ref)}, ${JSON.stringify(value ?? '')})`);
  return { filled: ref, value };
}

// Special (non-printable) keys mapped to the fields Input.dispatchKeyEvent
// expects. Printable characters are derived inline in keyPress.
const SPECIAL_KEYS: Record<string, { key: string; code: string; keyCode: number }> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  Space: { key: ' ', code: 'Space', keyCode: 32 },
};

async function keyPress(params: { key: string }): Promise<{ pressed: string }> {
  const tabId = requireTab();
  const key = params?.key;
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('key_press: key is required');
  }

  let mapped: { key: string; code: string; keyCode: number };
  if (key in SPECIAL_KEYS) {
    mapped = SPECIAL_KEYS[key];
  } else if (key.length === 1) {
    // Single printable character.
    const upper = key.toUpperCase();
    mapped = { key, code: `Key${upper}`, keyCode: upper.charCodeAt(0) };
  } else {
    throw new Error(`key_press: unsupported key: ${key}`);
  }

  await ensureDebuggerAttached(tabId);

  const base = {
    key: mapped.key,
    code: mapped.code,
    windowsVirtualKeyCode: mapped.keyCode,
  };
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
    type: 'keyDown',
    ...base,
  });
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    ...base,
  });

  return { pressed: key };
}

async function detach(): Promise<{ detached: true }> {
  const tabId = requireTab();
  await chrome.debugger.detach({ tabId }).catch(() => {});
  attachedTabs.delete(tabId);
  return { detached: true };
}

// --- Content-script-backed tools -------------------------------------------

async function selectOption(params: { ref: string; value: string }): Promise<{ selected: string; ref: string }> {
  const tabId = requireTab();
  const { ref, value } = params;
  if (!ref) throw new Error('select_option: ref is required');
  const ok = await evalInPage<boolean>(
    tabId,
    `typeof __xcshSelectOption==='function'?__xcshSelectOption(${JSON.stringify(ref)},${JSON.stringify(value)}):false`,
  );
  if (!ok) throw new Error(`option "${value}" not found in select ${ref}`);
  return { selected: value, ref };
}

async function scrollTo(params: { ref: string }): Promise<{ scrolled: string }> {
  const tabId = requireTab();
  const { ref } = params;
  if (!ref) throw new Error('scroll_to: ref is required');
  await evalInPage<void>(tabId, `typeof __xcshScrollTo==='function'&&__xcshScrollTo(${JSON.stringify(ref)})`);
  return { scrolled: ref };
}

async function getPageText(): Promise<{ text: string }> {
  const tabId = requireTab();
  // Use Runtime.evaluate via the debugger (MAIN world) — the content-script
  // ISOLATED-world read returned empty on the XC SPA, but the MAIN-world
  // document.body.innerText has the rendered text.
  await ensureDebuggerAttached(tabId);
  const result = (await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: "(document.body && document.body.innerText || '').slice(0, 50000)",
    returnByValue: true,
  })) as { result?: { value?: string } };
  return { text: result?.result?.value ?? '' };
}

// --- JavaScript evaluation (domain-scoped) ---------------------------------

async function javascriptTool(params: { code: string }): Promise<{ result: unknown }> {
  const tabId = requireTab();
  // Defense-in-depth (Phase 1 finding): cap evaluated code size.
  const code = params?.code;
  if (typeof code !== 'string') {
    throw new Error('javascript_tool: code is required');
  }
  if (code.length > MAX_JS_CODE_LEN) {
    throw new Error(`javascript_tool: code too large (${code.length} > ${MAX_JS_CODE_LEN})`);
  }
  // Domain-scope: the tab's current URL must be a scoped console URL.
  const tab = await chrome.tabs.get(tabId);
  if (typeof tab.url !== 'string' || !isScopedUrl(tab.url)) {
    throw new Error(`javascript_tool: tab is not on a scoped console domain: ${tab.url}`);
  }
  await ensureDebuggerAttached(tabId);
  const result = await evaluateWithRecovery(tabId, code);
  // biome-ignore lint/suspicious/noExplicitAny: Chrome extension API typings
  return { result: (result as any)?.result?.value };
}

/**
 * Runtime.evaluate with stale-context self-healing. After the OIDC login flow's
 * cross-origin redirects (or a Page.navigate), the debugger's default execution
 * context can go stale, and Runtime.evaluate then HANGS indefinitely (no timeout
 * on chrome.debugger.sendCommand) — which wedges every subsequent tool call. So
 * bound each evaluate; on timeout, detach + reattach the debugger (resetting to a
 * fresh context) and retry once.
 */
async function evaluateWithRecovery(tabId: number, code: string, timeoutMs = 8_000): Promise<unknown> {
  const evalOnce = () =>
    chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: code,
      returnByValue: true,
      awaitPromise: true,
    });
  const withTimeout = (p: Promise<unknown>) =>
    Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error('Runtime.evaluate timed out')), timeoutMs)),
    ]);
  try {
    return await withTimeout(evalOnce());
  } catch {
    // Reset the debugger session to clear a stale/frozen execution context.
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      /* already detached */
    }
    attachedTabs.delete(tabId);
    await ensureDebuggerAttached(tabId);
    return await withTimeout(evalOnce());
  }
}

// --- Tab / window management -----------------------------------------------

async function tabsList(): Promise<{
  tabs: Array<{
    id: number | undefined;
    url: string | undefined;
    title: string | undefined;
    active: boolean;
  }>;
}> {
  const tabs = await chrome.tabs.query({ url: ALLOWED_PATTERNS });
  return {
    tabs: tabs.map((t) => ({
      id: t.id,
      url: t.url,
      title: t.title,
      active: t.active,
    })),
  };
}

async function tabsCreate(params: { url: string }): Promise<{ tabId: number | undefined }> {
  const url = params?.url;
  if (typeof url !== 'string' || !isScopedUrl(url)) {
    throw new Error(`tabs_create: url not in scoped console domains: ${url}`);
  }
  if (isBlockedUrl(url)) {
    throw new Error(`tabs_create: url blocked by managed policy: ${url}`);
  }
  const tab = await chrome.tabs.create({ url, active: true });
  if (tab.id !== undefined) targetTabId = tab.id;
  return { tabId: tab.id };
}

async function tabsClose(params: { tabId: number }): Promise<{ closed: number }> {
  const { tabId } = params;
  // Neutralize beforeunload so closing a dirty-form tab doesn't block.
  await neutralizeBeforeunload(tabId);
  await chrome.tabs.remove(tabId);
  return { closed: tabId };
}

async function resizeWindow(params: {
  width: number;
  height: number;
}): Promise<{ resized: { width: number; height: number } }> {
  const tabId = requireTab();
  const { width, height } = params;
  const tab = await chrome.tabs.get(tabId);
  if (tab.windowId !== undefined) {
    await chrome.windows.update(tab.windowId, { width, height });
  }
  return { resized: { width, height } };
}

// --- Diagnostic reads (console / network) ----------------------------------

async function readConsole(params: { pattern?: string }): Promise<{ messages: Array<{ type: string; text: string }> }> {
  await enableConsoleObserver();
  const pattern = params?.pattern;
  // biome-ignore lint/suspicious/noExplicitAny: Chrome extension API typings
  let entries = consoleBuffer.map((e: any) => ({
    type: e.type,
    // biome-ignore lint/suspicious/noExplicitAny: Chrome extension API typings
    text: (e.args ?? []).map((a: any) => a.value ?? a.description).join(' '),
  }));
  if (pattern) entries = entries.filter((e) => e.text?.includes(pattern));
  return { messages: entries.slice(-100) };
}

/**
 * Wait for an API response matching a URL pattern in the network buffer.
 * Used after clicking Save to detect the server's response in REAL TIME
 * instead of guessing with a waitFor timeout. The F5 XC console POSTs to
 * `/api/config/namespaces/.../` on save — this watches for that response
 * and returns immediately with the status code + any error body.
 */
async function waitForApiResponse(params: {
  pattern?: string;
  timeout_ms?: number;
}): Promise<{ found: boolean; status?: number; url?: string; error?: string }> {
  await enableNetworkObserver();
  const pattern = params?.pattern ?? '/api/config/';
  const deadline = Date.now() + (params?.timeout_ms ?? 15000);
  const startIdx = networkBuffer.length; // only check NEW entries

  while (Date.now() < deadline) {
    for (let i = startIdx; i < networkBuffer.length; i++) {
      const e = networkBuffer[i] as any;
      if (e.method !== 'Network.responseReceived') continue;
      const url = e.response?.url ?? '';
      const status = e.response?.status ?? 0;
      if (!url.includes(pattern)) continue;

      // Found an API response — check if it's the save POST/PUT
      if (status >= 200 && status < 300) {
        return { found: true, status, url };
      }
      // Server rejected (4xx/5xx) — try to read the response body for the error
      if (status >= 400) {
        let error = `HTTP ${status}`;
        try {
          const tabId = requireTab();
          const body = (await chrome.debugger.sendCommand({ tabId }, 'Network.getResponseBody', {
            requestId: e.requestId,
          })) as { body?: string };
          if (body?.body) {
            const parsed = JSON.parse(body.body);
            error = parsed.message ?? parsed.error ?? JSON.stringify(parsed).slice(0, 200);
          }
        } catch {
          /* body not available */
        }
        return { found: true, status, url, error };
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { found: false, error: 'no matching API response within timeout' };
}

async function readNetwork(params: { pattern?: string }): Promise<{
  requests: Array<{
    method: string;
    url: string | undefined;
    status: number | undefined;
  }>;
}> {
  await enableNetworkObserver();
  const pattern = params?.pattern;
  // biome-ignore lint/suspicious/noExplicitAny: Chrome extension API typings
  let entries = networkBuffer.map((e: any) => ({
    method: e.method,
    url: e.request?.url ?? e.response?.url,
    status: e.response?.status,
  }));
  if (pattern) entries = entries.filter((e) => e.url?.includes(pattern));
  return { requests: entries.slice(-100) };
}

// --- File upload (best-effort, Phase 1) ------------------------------------

async function fileUpload(params: {
  ref: string;
  files: string[];
}): Promise<{ uploaded: string; fileCount: number; note: string }> {
  const { ref, files } = params;
  // Full implementation (Runtime.evaluate -> backendNodeId ->
  // DOM.setFileInputFiles) is Phase 2; resolving a WeakRef handle to a backend
  // node id is nontrivial. Return a best-effort acknowledgement for now.
  return {
    uploaded: ref,
    fileCount: Array.isArray(files) ? files.length : 0,
    note: 'file_upload full implementation is Phase 2',
  };
}

// --- Batch ------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: Chrome extension API typings
async function browserBatch(params: { actions: Array<{ tool: string; params: any }> }): Promise<{
  results: Array<{ tool: string; content: unknown; is_error: boolean }>;
}> {
  const actions = params?.actions ?? [];
  const results: Array<{ tool: string; content: unknown; is_error: boolean }> = [];
  for (const action of actions) {
    try {
      const content = await runTool(action.tool, action.params);
      results.push({ tool: action.tool, content, is_error: false });
    } catch (e) {
      results.push({ tool: action.tool, content: String(e), is_error: true });
      break; // abort the batch on first error
    }
  }
  return { results };
}

async function ensureDebuggerAttached(tabId: number): Promise<void> {
  if (attachedTabs.has(tabId)) return;
  // Verify the tab is on a console domain before attaching — chrome.debugger
  // rejects chrome://, chrome-extension://, and other restricted URLs.
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url && !isScopedUrl(tab.url)) {
      throw new Error(`tab ${tabId} is on ${tab.url} (not a console domain) — call navigate first`);
    }
    // biome-ignore lint/suspicious/noExplicitAny: Chrome extension API typings
  } catch (e: any) {
    if (/not a console domain/i.test(e?.message ?? '')) throw e;
    // tabs.get can fail if the tab was closed — let attach try + fail naturally.
  }
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attachedTabs.add(tabId);
    // biome-ignore lint/suspicious/noExplicitAny: Chrome extension API typings
  } catch (e: any) {
    // Already attached is fine — record it and move on.
    if (/already attached/i.test(e?.message ?? String(e))) {
      attachedTabs.add(tabId);
      return;
    }
    // Anything else: surface an actionable error. The overall timeout is
    // handled upstream by the bridge's request timeout, not here.
    throw new Error(
      `chrome.debugger.attach failed for tab ${tabId}: ${e?.message ?? e}. ` +
        `If Chrome shows a "debugging started" bar, leave it — xcsh will retry.`,
    );
  }
  // Enable Page so javascriptDialogOpening events fire and we can auto-handle
  // native "Leave site?"/alert/confirm dialogs (they would otherwise block).
  await chrome.debugger.sendCommand({ tabId }, 'Page.enable', {}).catch(() => {});
  // Enable DOM so DOM.getContentQuads / DOM.scrollIntoViewIfNeeded / DOM.resolveNode
  // are available — the deterministic, layout-engine click path (clickElementByObjectId)
  // resolves clickable geometry from the renderer instead of JS getBoundingClientRect.
  await chrome.debugger.sendCommand({ tabId }, 'DOM.enable', {}).catch(() => {});
}

// Keep `attachedTabs` consistent if the debugger detaches out-of-band
// (e.g. devtools opened, tab closed).
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) {
    attachedTabs.delete(source.tabId);
    latestApiCapture.delete(source.tabId);
  }
});

// Clear a tab's capture when it closes.
chrome.tabs.onRemoved.addListener((tabId) => {
  latestApiCapture.delete(tabId);
});
