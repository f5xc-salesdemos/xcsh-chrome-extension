/**
 * xcsh service worker — native-messaging client + the 5 tools.
 *
 * Connects to the native host `com.f5xc.xcsh.chrome_host`, handles the tool
 * protocol (`tool_request` -> `tool_result`, `ping` -> `pong`), and drives the
 * scoped F5 XC console tab via chrome.scripting + chrome.debugger.
 */

import {
  matchNode,
  matchNodes,
  parseLocator,
  type AxNode,
} from "./vendored-resolver";

const NATIVE_HOST = "com.f5xc.xcsh.chrome_host";
const RECONNECT_ALARM = "reconnect";
const MANAGED_POLICY_ALARM = "managed-policy-refresh";
const VERSION = "0.1.0";
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
    const stored = await chrome.storage.managed.get([
      "allowedDomains",
      "blockedUrlPatterns",
      "confirmBeforeMutating",
    ]);
    managedPolicy = {
      allowedDomains: Array.isArray(stored.allowedDomains)
        ? (stored.allowedDomains as string[])
        : undefined,
      blockedUrlPatterns: Array.isArray(stored.blockedUrlPatterns)
        ? (stored.blockedUrlPatterns as string[])
        : undefined,
      confirmBeforeMutating:
        typeof stored.confirmBeforeMutating === "boolean"
          ? (stored.confirmBeforeMutating as boolean)
          : undefined,
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
  return patterns.some((p) => typeof p === "string" && p.length > 0 && normalized.includes(p.toLowerCase()));
}

// Scoped console URL patterns (also the host_permissions in the manifest).
const SCOPED_QUERY_PATTERNS = [
  "https://*.volterra.us/*",
  "https://*.console.ves.volterra.io/*",
];

function isScopedUrl(url: string): boolean {
  return (
    /^https:\/\/[^/]*\.volterra\.us\//.test(url) ||
    /^https:\/\/[^/]*\.console\.ves\.volterra\.io\//.test(url)
  );
}

// --- Native-messaging connection + lifecycle -------------------------------

let port: chrome.runtime.Port | null = null;

// The console tab the SW is currently driving (set in `navigate`).
let targetTabId: number | undefined;

// Tabs we have attached the debugger to, so we can detach on cleanup and avoid
// re-attaching needlessly.
const attachedTabs = new Set<number>();

// Allowed console URL patterns for tabs_list (mirrors host_permissions).
const ALLOWED_PATTERNS = [
  "https://*.volterra.us/*",
  "https://*.console.ves.volterra.io/*",
];

// --- Diagnostic event buffers (read_console / read_network) ----------------

// Ring buffers of CDP events, capped at 500 entries each.
const consoleBuffer: any[] = [];
const networkBuffer: any[] = [];
let observingConsole = false;
let observingNetwork = false;

async function enableConsoleObserver(): Promise<void> {
  if (observingConsole) return;
  const tabId = requireTab();
  await ensureDebuggerAttached(tabId);
  await chrome.debugger.sendCommand({ tabId }, "Runtime.enable", {});
  observingConsole = true;
}

async function enableNetworkObserver(): Promise<void> {
  if (observingNetwork) return;
  const tabId = requireTab();
  await ensureDebuggerAttached(tabId);
  await chrome.debugger.sendCommand({ tabId }, "Network.enable", {});
  observingNetwork = true;
}

// Push CDP events for the target tab into the diagnostic ring buffers.
chrome.debugger.onEvent.addListener((source, method, eventParams) => {
  if (source.tabId === undefined || source.tabId !== targetTabId) return;
  if (method === "Runtime.consoleAPICalled") {
    consoleBuffer.push(eventParams);
    if (consoleBuffer.length > 500) consoleBuffer.shift();
  } else if (
    method === "Network.requestWillBeSent" ||
    method === "Network.responseReceived"
  ) {
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

function onMessage(msg: any): void {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "ping") {
    port?.postMessage({ type: "pong" });
    return;
  }

  if (msg.type === "tool_request") {
    const { id, tool, params } = msg;
    runTool(tool, params)
      .then((content) => {
        port?.postMessage({ type: "tool_result", id, content, is_error: false });
      })
      .catch((e) => {
        port?.postMessage({
          type: "tool_result",
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
  if (areaName === "managed") {
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
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "status_request") {
    sendResponse({ connected: !!port });
    return; // synchronous response
  }

  if (msg.type === "stop_agent") {
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
        chrome.tabs
          .sendMessage(tab.id, { type: "indicator_hide" })
          .catch(() => {});
      }
    }
  });
}

// --- Tool implementations --------------------------------------------------

async function runTool(tool: string, params: any): Promise<unknown> {
  // Pulse the on-page indicator while any non-trivial tool runs.
  const broadcastsIndicator = tool !== "ping";
  if (broadcastsIndicator && targetTabId !== undefined) {
    chrome.tabs
      .sendMessage(targetTabId, { type: "indicator_show" })
      .catch(() => {});
  }
  try {
    return await dispatchTool(tool, params);
  } finally {
    if (broadcastsIndicator && targetTabId !== undefined) {
      chrome.tabs
        .sendMessage(targetTabId, { type: "indicator_hide" })
        .catch(() => {});
    }
  }
}

async function dispatchTool(tool: string, params: any): Promise<unknown> {
  switch (tool) {
    case "ping":
      return { ok: true, version: VERSION };

    case "navigate":
      return navigate(params);

    case "select_option":
      return selectOption(params);

    case "scroll_to":
      return scrollTo(params);

    case "get_page_text":
      return getPageText();

    case "javascript_tool":
      return javascriptTool(params);

    case "tabs_list":
      return tabsList();

    case "tabs_create":
      return tabsCreate(params);

    case "tabs_close":
      return tabsClose(params);

    case "resize_window":
      return resizeWindow(params);

    case "read_console":
      return readConsole(params);

    case "read_network":
      return readNetwork(params);

    case "file_upload":
      return fileUpload(params);

    case "browser_batch":
      return browserBatch(params);

    case "read_ax":
      return readAx();

    case "wait_for":
      return waitFor(params);

    case "assert_text":
      return assertText(params);

    case "find":
      return find(params);

    case "click":
      return click(params);

    case "screenshot":
      return screenshot();

    case "form_input":
      return formInput(params);

    case "key_press":
      return keyPress(params);

    case "detach":
      return detach();

    default:
      throw new Error(`unknown tool: ${tool}`);
  }
}

async function navigate(params: { url: string }): Promise<{ tabId: number }> {
  const url = params?.url;
  if (typeof url !== "string" || !isScopedUrl(url)) {
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
  if (scheme !== "https:") {
    throw new Error(`navigate: only https: urls are allowed, got ${scheme}`);
  }

  // Enterprise policy override: refuse URLs matching any blocked pattern,
  // even within otherwise-allowed console domains.
  if (isBlockedUrl(url)) {
    throw new Error(`navigate: url blocked by managed policy: ${url}`);
  }

  // Find or create the console tab.
  const existing = await chrome.tabs.query({ url: SCOPED_QUERY_PATTERNS });
  if (existing.length > 0 && existing[0].id !== undefined) {
    targetTabId = existing[0].id;
  } else {
    const created = await chrome.tabs.create({ url });
    if (created.id === undefined) {
      throw new Error("navigate: failed to create console tab");
    }
    targetTabId = created.id;
  }

  const tabId = targetTabId;

  await chrome.tabs.update(tabId, { url, active: true });

  // Wait for navigation to complete on that tab (race with a timeout).
  await waitForNavigation(tabId);

  return { tabId };
}

function waitForNavigation(tabId: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;

    const onCompleted = (
      details: chrome.webNavigation.WebNavigationFramedCallbackDetails,
    ) => {
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
    throw new Error("no target tab — call navigate first");
  }
  return targetTabId;
}

/** Run `__xcshReadAx()` in the target tab and return the AX tree. */
async function readAxFromTab(): Promise<AxNode> {
  const tabId = requireTab();
  // The content script installs __xcshReadAx in the ISOLATED world (same as
  // executeScript's default). Retry briefly if the content script hasn't
  // initialized yet (e.g., right after a navigation).
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const result = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => (globalThis as any).__xcshReadAx?.() ?? null,
      });
      const tree = result[0]?.result;
      if (tree && typeof tree === "object" && "role" in tree) return tree as AxNode;
    } catch {
      // executeScript can fail if the page is still loading / navigating.
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error("read_ax: content script __xcshReadAx not available (page may still be loading)");
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
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (r: string) => (globalThis as any).__xcshGetInnerText(r),
    args: [node.ref as string],
  });
  const text = (result?.result as string) ?? "";
  if (!text.includes(expected)) {
    throw new Error(
      `assert failed: "${expected}" not in "${text.slice(0, 200)}"`,
    );
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
      name: (n.name as string) ?? "",
    })),
  };
}

async function click(params: {
  ref: string;
}): Promise<{ clicked: string; x: number; y: number }> {
  const tabId = requireTab();
  const ref = params?.ref;

  // Resolve the ref to viewport coords inside the page.
  const resolved = await chrome.scripting.executeScript({
    target: { tabId },
    func: (r: string) => (globalThis as any).__xcshResolveRef(r),
    args: [ref],
  });
  const coords = resolved[0]?.result as { x: number; y: number } | null;
  if (!coords) {
    throw new Error(`click: could not resolve ref: ${ref}`);
  }
  const { x, y } = coords;

  await ensureDebuggerAttached(tabId);

  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });

  return { clicked: ref, x, y };
}

async function screenshot(): Promise<{ data: string }> {
  const tabId = requireTab();
  await ensureDebuggerAttached(tabId);
  const result = (await chrome.debugger.sendCommand(
    { tabId },
    "Page.captureScreenshot",
    { format: "png" },
  )) as { data: string };
  return { data: result.data };
}

async function formInput(params: {
  ref: string;
  value: string;
}): Promise<{ filled: string; value: string }> {
  const tabId = requireTab();
  const ref = params?.ref;
  const value = params?.value;

  // Commit the value via the content-script helper (handles vsui-input quirks).
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: (r: string, v: string) =>
      (globalThis as any).__xcshCommitInputValue(r, v),
    args: [ref, value],
  });
  const r0 = result[0] as { error?: { message?: string } } | undefined;
  if (r0?.error) {
    throw new Error(r0.error.message ?? `form_input failed for ref: ${ref}`);
  }

  return { filled: ref, value };
}

// Special (non-printable) keys mapped to the fields Input.dispatchKeyEvent
// expects. Printable characters are derived inline in keyPress.
const SPECIAL_KEYS: Record<
  string,
  { key: string; code: string; keyCode: number }
> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13 },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  Space: { key: " ", code: "Space", keyCode: 32 },
};

async function keyPress(params: {
  key: string;
}): Promise<{ pressed: string }> {
  const tabId = requireTab();
  const key = params?.key;
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("key_press: key is required");
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
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
    type: "keyDown",
    ...base,
  });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
    type: "keyUp",
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

async function selectOption(params: {
  ref: string;
  value: string;
}): Promise<{ selected: string; ref: string }> {
  const tabId = requireTab();
  const { ref, value } = params;
  const [r] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (rr: string, vv: string) =>
      (globalThis as any).__xcshSelectOption(rr, vv),
    args: [ref, value],
  });
  if (!r?.result) {
    throw new Error(`option "${value}" not found in select ${ref}`);
  }
  return { selected: value, ref };
}

async function scrollTo(params: { ref: string }): Promise<{ scrolled: string }> {
  const tabId = requireTab();
  const { ref } = params;
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (rr: string) => (globalThis as any).__xcshScrollTo(rr),
    args: [ref],
  });
  return { scrolled: ref };
}

async function getPageText(): Promise<{ text: string }> {
  const tabId = requireTab();
  const [r] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => (globalThis as any).__xcshGetPageText(),
  });
  return { text: (r?.result as string) ?? "" };
}

// --- JavaScript evaluation (domain-scoped) ---------------------------------

async function javascriptTool(params: {
  code: string;
}): Promise<{ result: unknown }> {
  const tabId = requireTab();
  // Defense-in-depth (Phase 1 finding): cap evaluated code size.
  const code = params?.code;
  if (typeof code !== "string") {
    throw new Error("javascript_tool: code is required");
  }
  if (code.length > MAX_JS_CODE_LEN) {
    throw new Error(
      `javascript_tool: code too large (${code.length} > ${MAX_JS_CODE_LEN})`,
    );
  }
  // Domain-scope: the tab's current URL must be a scoped console URL.
  const tab = await chrome.tabs.get(tabId);
  if (typeof tab.url !== "string" || !isScopedUrl(tab.url)) {
    throw new Error(
      `javascript_tool: tab is not on a scoped console domain: ${tab.url}`,
    );
  }
  await ensureDebuggerAttached(tabId);
  const result = (await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
    expression: code,
    returnByValue: true,
    awaitPromise: true,
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

async function tabsCreate(params: {
  url: string;
}): Promise<{ tabId: number | undefined }> {
  const url = params?.url;
  if (typeof url !== "string" || !isScopedUrl(url)) {
    throw new Error(`tabs_create: url not in scoped console domains: ${url}`);
  }
  if (isBlockedUrl(url)) {
    throw new Error(`tabs_create: url blocked by managed policy: ${url}`);
  }
  const tab = await chrome.tabs.create({ url, active: true });
  if (tab.id !== undefined) targetTabId = tab.id;
  return { tabId: tab.id };
}

async function tabsClose(params: {
  tabId: number;
}): Promise<{ closed: number }> {
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

async function readConsole(params: {
  pattern?: string;
}): Promise<{ messages: Array<{ type: string; text: string }> }> {
  await enableConsoleObserver();
  const pattern = params?.pattern;
  let entries = consoleBuffer.map((e: any) => ({
    type: e.type,
    text: (e.args ?? [])
      .map((a: any) => a.value ?? a.description)
      .join(" "),
  }));
  if (pattern) entries = entries.filter((e) => e.text?.includes(pattern));
  return { messages: entries.slice(-100) };
}

async function readNetwork(params: {
  pattern?: string;
}): Promise<{
  requests: Array<{
    method: string;
    url: string | undefined;
    status: number | undefined;
  }>;
}> {
  await enableNetworkObserver();
  const pattern = params?.pattern;
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
    note: "file_upload full implementation is Phase 2",
  };
}

// --- Batch ------------------------------------------------------------------

async function browserBatch(params: {
  actions: Array<{ tool: string; params: any }>;
}): Promise<{
  results: Array<{ tool: string; content: unknown; is_error: boolean }>;
}> {
  const actions = params?.actions ?? [];
  const results: Array<{ tool: string; content: unknown; is_error: boolean }> =
    [];
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
  } catch (e: any) {
    if (/not a console domain/i.test(e?.message ?? "")) throw e;
    // tabs.get can fail if the tab was closed — let attach try + fail naturally.
  }
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    attachedTabs.add(tabId);
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
        `If Chrome shows a "debugging started" bar, click "Cancel" to ` +
        `dismiss it — xcsh will retry.`,
    );
  }
}

// Keep `attachedTabs` consistent if the debugger detaches out-of-band
// (e.g. devtools opened, tab closed).
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) attachedTabs.delete(source.tabId);
});
