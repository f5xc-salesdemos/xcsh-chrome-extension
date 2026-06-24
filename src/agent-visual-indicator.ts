/**
 * Agent visual indicator — content script (IIFE, document_idle, main frame).
 *
 * Renders an F5-red pulsing border glow plus a floating "xcsh" badge with a
 * stop button while the agent is driving the console tab. Toggled by
 * `indicator_show` / `indicator_hide` runtime messages from the service worker.
 *
 * Visibility uses a three-phase opacity envelope:
 *   1. ATTACK  — a fast snap to full brightness when activity begins.
 *   2. HOLD    — a minimum dwell at full brightness after the most recent
 *                trigger; a hide that arrives inside this window is deferred so
 *                a brief blip stays lit instead of fading the instant it ends.
 *   3. RELEASE — a gentle, capacitor-style discharge once the hold has elapsed.
 *
 * The service worker fires show/hide around every tool call, so the hold plus
 * the slow release bridge the brief gaps between consecutive calls: a burst of
 * activity reads as one steady, breathing glow instead of strobing on and off.
 * The elements are created once and kept (toggled via opacity), then cleaned up
 * only after a full release has elapsed.
 */

const GLOW_ID = '__xcsh-agent-glow';
const BADGE_ID = '__xcsh-agent-badge';

const ATTACK = 'opacity 120ms ease-out'; // quick snap to bright when activity begins
const HOLD_MS = 800; // minimum dwell at full brightness after a trigger before discharge
const RELEASE = 'opacity 1400ms ease-out'; // gentle discharge after the hold elapses
const CLEANUP_MS = 1500; // remove from DOM once the release has fully faded

let glow: HTMLDivElement | undefined;
let badge: HTMLDivElement | undefined;
let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
let holdTimer: ReturnType<typeof setTimeout> | undefined;
let peakAt = 0; // timestamp (performance.now) of the most recent snap to full brightness

function createElements(): void {
  glow = document.createElement('div');
  glow.id = GLOW_ID;
  glow.style.cssText =
    'position:fixed;inset:0;pointer-events:none;z-index:2147483647;opacity:0;box-shadow:inset 0 0 8px 2px #E4002B;animation:xcsh-pulse 2s ease-in-out infinite;';
  const style = document.createElement('style');
  style.textContent =
    '@keyframes xcsh-pulse{0%,100%{box-shadow:inset 0 0 8px 2px #E4002B}50%{box-shadow:inset 0 0 16px 4px #E4002B}}';
  glow.appendChild(style);
  document.documentElement.appendChild(glow);

  badge = document.createElement('div');
  badge.id = BADGE_ID;
  badge.style.cssText =
    'position:fixed;top:8px;right:8px;z-index:2147483647;opacity:0;background:#E4002B;color:#fff;font:600 13px/1 Inter,system-ui,sans-serif;padding:6px 14px;border-radius:6px;display:flex;align-items:center;gap:8px;box-shadow:0 2px 8px rgba(0,0,0,.3);cursor:default;';
  badge.innerHTML =
    '<span style="font-size:11px">⬢</span> xcsh <button style="background:none;border:none;color:#fff;cursor:pointer;font-size:16px;line-height:1;padding:0 0 0 4px" title="Stop">✕</button>';
  badge.querySelector('button')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'stop_agent' });
  });
  document.documentElement.appendChild(badge);
}

function showIndicator(): void {
  // A pending hold or cleanup means we're already lit (or mid-release); cancel
  // both and snap back to full — a fresh trigger restarts the hold window.
  if (holdTimer !== undefined) {
    clearTimeout(holdTimer);
    holdTimer = undefined;
  }
  if (cleanupTimer !== undefined) {
    clearTimeout(cleanupTimer);
    cleanupTimer = undefined;
  }

  const firstAppearance = glow === undefined;
  if (firstAppearance) createElements();
  if (!glow || !badge) return;

  // Force a reflow on first appearance so the opacity:0 → 1 transition animates
  // from the initial state instead of snapping straight to full brightness.
  if (firstAppearance) void glow.offsetHeight;

  glow.style.transition = ATTACK;
  glow.style.opacity = '1';
  badge.style.transition = ATTACK;
  badge.style.opacity = '1';
  badge.style.pointerEvents = 'auto';
  peakAt = performance.now();
}

function hideIndicator(): void {
  if (!glow || !badge) return;
  if (holdTimer !== undefined) return; // discharge already queued; nothing to do

  // Enforce the minimum hold: if the trigger was less than HOLD_MS ago, defer
  // the discharge until the rest of the window has elapsed.
  const remaining = HOLD_MS - (performance.now() - peakAt);
  if (remaining > 0) {
    holdTimer = setTimeout(() => {
      holdTimer = undefined;
      beginRelease();
    }, remaining);
    return;
  }
  beginRelease();
}

function beginRelease(): void {
  if (!glow || !badge) return;

  glow.style.transition = RELEASE;
  glow.style.opacity = '0';
  badge.style.transition = RELEASE;
  badge.style.opacity = '0';
  badge.style.pointerEvents = 'none'; // invisible badge must not eat clicks

  if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
  cleanupTimer = setTimeout(() => {
    glow?.remove();
    badge?.remove();
    glow = undefined;
    badge = undefined;
    cleanupTimer = undefined;
  }, CLEANUP_MS);
}

chrome.runtime.onMessage.addListener((msg: { type?: string }) => {
  if (msg?.type === 'indicator_show') showIndicator();
  if (msg?.type === 'indicator_hide') hideIndicator();
});
