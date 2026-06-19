/**
 * xcsh service worker — native-messaging client + the 5 tools.
 *
 * Connects to the native host `com.f5xc.xcsh.chrome_host`, handles the tool
 * protocol (`tool_request` -> `tool_result`, `ping` -> `pong`), and drives the
 * scoped F5 XC console tab via chrome.scripting + chrome.debugger.
 */

const NATIVE_HOST = "com.f5xc.xcsh.chrome_host";
const RECONNECT_ALARM = "reconnect";
const VERSION = "0.1.0";
const NAV_TIMEOUT_MS = 30_000;

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

function connect(): void {
  if (port) return;
  port = chrome.runtime.connectNative(NATIVE_HOST);
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    // The reconnect alarm will bring us back up.
    port = null;
  });
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

// Reconnect alarm (~0.5 min) — reconnects whenever the port has been nulled.
chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM && !port) {
    connect();
  }
});

// --- Tool implementations --------------------------------------------------

async function runTool(tool: string, params: any): Promise<unknown> {
  switch (tool) {
    case "ping":
      return { ok: true, version: VERSION };

    case "navigate":
      return navigate(params);

    case "read_ax":
      return readAx();

    case "click":
      return click(params);

    case "screenshot":
      return screenshot();

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

async function readAx(): Promise<unknown> {
  const tabId = requireTab();
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => (globalThis as any).__xcshReadAx(),
  });
  return result[0]?.result;
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

  await ensureAttached(tabId);

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
  await ensureAttached(tabId);
  const result = (await chrome.debugger.sendCommand(
    { tabId },
    "Page.captureScreenshot",
    { format: "png" },
  )) as { data: string };
  return { data: result.data };
}

async function detach(): Promise<{ detached: true }> {
  const tabId = requireTab();
  await chrome.debugger.detach({ tabId }).catch(() => {});
  attachedTabs.delete(tabId);
  return { detached: true };
}

async function ensureAttached(tabId: number): Promise<void> {
  if (attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (e) {
    // Already attached is fine; rethrow anything else.
    if (!/already attached/i.test(String(e))) throw e;
  }
  attachedTabs.add(tabId);
}

// Keep `attachedTabs` consistent if the debugger detaches out-of-band
// (e.g. devtools opened, tab closed).
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) attachedTabs.delete(source.tabId);
});
