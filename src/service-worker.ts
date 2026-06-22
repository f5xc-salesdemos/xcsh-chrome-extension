/**
 * xcsh service worker — native-messaging client + the 5 tools.
 *
 * Connects to the native host `com.f5xc.xcsh.chrome_host`, handles the tool
 * protocol (`tool_request` -> `tool_result`, `ping` -> `pong`), and drives the
 * scoped F5 XC console tab via chrome.scripting + chrome.debugger.
 */

import { type AxNode, matchNode, matchNodes, parseLocator } from './vendored-resolver';

const NATIVE_HOST = 'com.f5xc.xcsh.chrome_host';
const RECONNECT_ALARM = 'reconnect';
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

// --- Native-messaging connection + lifecycle -------------------------------

let port: chrome.runtime.Port | null = null;

// The console tab the SW is currently driving (set in `navigate`).
let targetTabId: number | undefined;

// Cached login credentials for session-expiry auto-recovery. Set by login(),
// used by navigate() to transparently re-authenticate when the session expires.
// In-memory only — never persisted.
let lastLoginCredentials: { email: string; password: string; consoleUrl: string } | null = null;

// Tabs we have attached the debugger to, so we can detach on cleanup and avoid
// re-attaching needlessly.
const attachedTabs = new Set<number>();

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
  }
});

function connect(): void {
  if (port) return;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(() => {
      // The reconnect alarm will bring us back up.
      port = null;
    });
  } catch {
    // Native host not available yet (e.g. xcsh not running at startup).
    // Silently retry on the next reconnect alarm — no extension error badge.
    port = null;
  }
}

// biome-ignore lint/suspicious/noExplicitAny: Chrome extension API typings
function onMessage(msg: any): void {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'ping') {
    port?.postMessage({ type: 'pong' });
    return;
  }

  if (msg.type === 'tool_request') {
    const { id, tool, params } = msg;
    runTool(tool, params)
      .then((content) => {
        port?.postMessage({ type: 'tool_result', id, content, is_error: false });
      })
      .catch((e) => {
        port?.postMessage({
          type: 'tool_result',
          id,
          content: String(e),
          is_error: true,
        });
      });
  }
}

// Connect on SW startup.
connect();

// Read the managed enterprise policy on startup.
refreshManagedPolicy();

// Re-read the managed policy if enterprise policy changes at runtime.
chrome.storage.onChanged.addListener((_changes, areaName) => {
  if (areaName === 'managed') {
    refreshManagedPolicy();
  }
});

// Reconnect alarm (~0.5 min) — reconnects whenever the port has been nulled.
chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
// Managed-policy refresh alarm (~5 min) — picks up policy pushes even if the
// onChanged event was missed while the SW was suspended.
chrome.alarms.create(MANAGED_POLICY_ALARM, { periodInMinutes: 5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM && !port) {
    connect();
  } else if (alarm.name === MANAGED_POLICY_ALARM) {
    refreshManagedPolicy();
  }
});

// --- Runtime messages from the options page + visual indicator -------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'status_request') {
    sendResponse({ connected: !!port });
    return; // synchronous response
  }

  if (msg.type === 'stop_agent') {
    stopAgent();
    return;
  }
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
  // Pulse the on-page indicator while any non-trivial tool runs.
  const broadcastsIndicator = tool !== 'ping';
  if (broadcastsIndicator && targetTabId !== undefined) {
    chrome.tabs.sendMessage(targetTabId, { type: 'indicator_show' }).catch(() => {});
  }
  try {
    return await dispatchTool(tool, params);
  } finally {
    if (broadcastsIndicator && targetTabId !== undefined) {
      chrome.tabs.sendMessage(targetTabId, { type: 'indicator_hide' }).catch(() => {});
    }
  }
}

// biome-ignore lint/suspicious/noExplicitAny: Chrome extension API typings
async function dispatchTool(tool: string, params: any): Promise<unknown> {
  switch (tool) {
    case 'ping':
      return { ok: true, version: VERSION };

    case 'reload': {
      // Reload the extension programmatically (re-reads dist/ from disk).
      // The SW restarts, native port reconnects via the 30s alarm.
      chrome.runtime.reload();
      return { reloading: true };
    }

    case 'debug_exec': {
      // Diagnostic: test if __xcshReadAx is available via the debugger path.
      const tabId = requireTab();
      return evalInPage(tabId, '({ts:Date.now(),title:document.title,xcsh:typeof __xcshReadAx})');
    }

    case 'navigate':
      return navigate(params);

    case 'login':
      return login(params);

    case 'select_option':
      return selectOption(params);

    case 'scroll_to':
      return scrollTo(params);

    case 'get_page_text':
      return getPageText();

    case 'javascript_tool':
      return javascriptTool(params);

    case 'tabs_list':
      return tabsList();

    case 'tabs_create':
      return tabsCreate(params);

    case 'tabs_close':
      return tabsClose(params);

    case 'resize_window':
      return resizeWindow(params);

    case 'read_console':
      return readConsole(params);

    case 'read_network':
      return readNetwork(params);

    case 'file_upload':
      return fileUpload(params);

    case 'browser_batch':
      return browserBatch(params);

    case 'read_ax':
      return readAx();

    case 'wait_for':
      return waitFor(params);

    case 'assert_text':
      return assertText(params);

    case 'find':
      return find(params);

    case 'click':
      return click(params);

    case 'screenshot':
      return screenshot();

    case 'form_input':
      return formInput(params);

    case 'key_press':
      return keyPress(params);

    case 'detach':
      return detach();

    default:
      throw new Error(`unknown tool: ${tool}`);
  }
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
    try {
      await ensureDebuggerAttached(tabId);
      await chrome.debugger.sendCommand({ tabId }, 'Page.navigate', { url });
    } catch {
      // Fallback: debugger may not attach on some pages (chrome://, etc.)
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
    if (tab.url && isKeycloakLoginUrl(tab.url) && lastLoginCredentials) {
      await login(lastLoginCredentials);
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
  const { tabId } = await navigate({ url: consoleUrl });
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

async function click(params: { ref: string }): Promise<{ clicked: string; x: number; y: number }> {
  const tabId = requireTab();
  const ref = params?.ref;
  if (!ref) throw new Error('click: ref is required');
  // Resolve the ref → viewport coords via the debugger (executeScript hangs on XC SPA).
  const coords = await evalInPage<{ x: number; y: number } | null>(
    tabId,
    `typeof __xcshResolveRef === 'function' ? __xcshResolveRef(${JSON.stringify(ref)}) : null`,
  );
  if (!coords) throw new Error(`click: could not resolve ref: ${ref}`);
  const { x, y } = coords;
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
  return { clicked: ref, x, y };
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
  const result = (await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: code,
    returnByValue: true,
    awaitPromise: true,
    // biome-ignore lint/suspicious/noExplicitAny: Chrome extension API typings
  })) as any;
  return { result: result?.result?.value };
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
}

// Keep `attachedTabs` consistent if the debugger detaches out-of-band
// (e.g. devtools opened, tab closed).
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) attachedTabs.delete(source.tabId);
});
