/**
 * Agent visual indicator — content script (IIFE, document_idle, main frame).
 *
 * Renders an F5-red pulsing border glow plus a floating "xcsh" badge with a
 * stop button while the agent is driving the console tab. Toggled by
 * `indicator_show` / `indicator_hide` runtime messages from the service worker.
 *
 * The timing — a fast attack, a minimum hold at full brightness, then a gentle
 * capacitor-style release — lives in the pure, unit-tested `indicator-envelope`
 * state machine. This file is the DOM/Chrome adapter: it supplies the visual
 * effects (opacity transitions, element teardown) and the real clock + timers,
 * and wires runtime messages to the envelope. The service worker fires show/hide
 * around every tool call, so the hold plus the slow release bridge the brief
 * gaps between consecutive calls: a burst reads as one steady, breathing glow.
 */

import { createEnvelope, type EnvelopeEffects } from './indicator-envelope';

const GLOW_ID = '__xcsh-agent-glow';
const BADGE_ID = '__xcsh-agent-badge';

const ATTACK = 'opacity 120ms ease-out'; // quick snap to bright when activity begins
const HOLD_MS = 800; // minimum dwell at full brightness after a trigger before discharge
const RELEASE = 'opacity 1400ms ease-out'; // gentle discharge after the hold elapses
const CLEANUP_MS = 1500; // remove from DOM once the release has fully faded

let glow: HTMLDivElement | undefined;
let badge: HTMLDivElement | undefined;

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

const effects: EnvelopeEffects = {
  onAttack(): void {
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
  },
  onRelease(): void {
    if (!glow || !badge) return;
    glow.style.transition = RELEASE;
    glow.style.opacity = '0';
    badge.style.transition = RELEASE;
    badge.style.opacity = '0';
    badge.style.pointerEvents = 'none'; // invisible badge must not eat clicks
  },
  onCleanup(): void {
    glow?.remove();
    badge?.remove();
    glow = undefined;
    badge = undefined;
  },
  now: () => performance.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (id) => clearTimeout(id),
};

const envelope = createEnvelope(effects, { holdMs: HOLD_MS, cleanupMs: CLEANUP_MS });

chrome.runtime.onMessage.addListener((msg: { type?: string }) => {
  if (msg?.type === 'indicator_show') envelope.show();
  if (msg?.type === 'indicator_hide') envelope.hide();
});
