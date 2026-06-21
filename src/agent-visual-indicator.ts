/**
 * Agent visual indicator — content script (IIFE, document_idle, main frame).
 *
 * Renders an F5-red pulsing border glow plus a floating "F5 XC Agent" badge
 * with a stop button while the agent is driving the console tab. Toggled by
 * `indicator_show` / `indicator_hide` runtime messages from the service worker.
 */

const GLOW_ID = "__xcsh-agent-glow";
const BADGE_ID = "__xcsh-agent-badge";

function showIndicator(): void {
  if (document.getElementById(GLOW_ID)) return;

  const glow = document.createElement("div");
  glow.id = GLOW_ID;
  glow.style.cssText =
    "position:fixed;inset:0;pointer-events:none;z-index:2147483647;box-shadow:inset 0 0 8px 2px #E4002B;animation:xcsh-pulse 2s ease-in-out infinite;";
  const style = document.createElement("style");
  style.textContent =
    "@keyframes xcsh-pulse{0%,100%{box-shadow:inset 0 0 8px 2px #E4002B}50%{box-shadow:inset 0 0 16px 4px #E4002B}}";
  glow.appendChild(style);
  document.documentElement.appendChild(glow);

  const badge = document.createElement("div");
  badge.id = BADGE_ID;
  badge.style.cssText =
    "position:fixed;top:8px;right:8px;z-index:2147483647;background:#E4002B;color:#fff;font:600 13px/1 Inter,system-ui,sans-serif;padding:6px 14px;border-radius:6px;display:flex;align-items:center;gap:8px;box-shadow:0 2px 8px rgba(0,0,0,.3);cursor:default;";
  badge.innerHTML =
    '<span style="font-size:11px">⬢</span> xcsh <button style="background:none;border:none;color:#fff;cursor:pointer;font-size:16px;line-height:1;padding:0 0 0 4px" title="Stop">✕</button>';
  badge.querySelector("button")!.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "stop_agent" });
  });
  document.documentElement.appendChild(badge);
}

function hideIndicator(): void {
  document.getElementById(GLOW_ID)?.remove();
  document.getElementById(BADGE_ID)?.remove();
}

chrome.runtime.onMessage.addListener((msg: { type?: string }) => {
  if (msg?.type === "indicator_show") showIndicator();
  if (msg?.type === "indicator_hide") hideIndicator();
});
