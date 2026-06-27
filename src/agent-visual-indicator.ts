/**
 * Agent visual indicator — content script (IIFE, document_idle, main frame).
 *
 * Renders a thin red "scanner" bar that shimmers softly back and forth across
 * the very top edge of the page, plus a tiny "terminal effigy" emblem — a
 * cartoon of the xcsh TUI welcome frame: a rounded deep-red border on near-black
 * with the title "xcsh" inset into the top border and the F5 mark inside — while
 * the agent is driving the console tab. Toggled by `indicator_show` /
 * `indicator_hide` runtime messages from the service worker.
 *
 * The timing — a fast attack, a minimum hold at full brightness, then a gentle
 * capacitor-style release — lives in the pure, unit-tested `indicator-envelope`
 * state machine. This file is the DOM/Chrome adapter: it supplies the visual
 * effects (opacity transitions, element teardown) and the real clock + timers,
 * and wires runtime messages to the envelope. The service worker fires show/hide
 * around every tool call, so the hold plus the slow release bridge the brief
 * gaps between consecutive calls: a burst reads as one steady, breathing shimmer.
 */

import { F5_LOGO_DATA_URI } from './f5-logo';
import { createEnvelope, type EnvelopeEffects } from './indicator-envelope';

const SCANNER_ID = '__xcsh-agent-scanner';
const BADGE_ID = '__xcsh-agent-badge';

const RED = '#ca260a'; // xcsh CLI frame red — keeps brand parity with the terminal UI

const ATTACK = 'opacity 120ms ease-out'; // quick snap to bright when activity begins
const HOLD_MS = 800; // minimum dwell at full brightness after a trigger before discharge
const RELEASE = 'opacity 1400ms ease-out'; // gentle discharge after the hold elapses
const CLEANUP_MS = 1500; // remove from DOM once the release has fully faded

let scanner: HTMLDivElement | undefined;
let badge: HTMLDivElement | undefined;

function createElements(): void {
  // Red "scanner" bar pinned to the very top edge: a wide, bright highlight glides
  // back and forth over a tinted track, with a soft glow bloom beneath it. The
  // sweep uses ease-in-out so it slows and reverses smoothly at each edge (velocity
  // hits zero at the turn) — a clear but non-flickering "agent is thinking" signal.
  // overflow:hidden clips the highlight to the bar height; the host's own
  // box-shadow is the part that blooms below. Isolated in a Shadow DOM so the host
  // page's CSS can never affect it.
  scanner = document.createElement('div');
  scanner.id = SCANNER_ID;
  scanner.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:6px;z-index:2147483647;opacity:0;pointer-events:none;overflow:hidden;box-shadow:0 1px 12px 0 rgba(202,38,10,.6);';
  const sroot = scanner.attachShadow({ mode: 'open' });
  sroot.innerHTML =
    '<style>' +
    ':host{display:block}' +
    '.track{position:absolute;inset:0}' +
    `.track::before{content:"";position:absolute;inset:0;background:${RED};opacity:.34}` +
    '.blob{position:absolute;top:0;height:100%;width:26vw;' +
    'filter:blur(.5px) drop-shadow(0 0 7px rgba(255,106,61,.95)) drop-shadow(0 0 14px rgba(202,38,10,.6));' +
    'background:linear-gradient(90deg,transparent,#e8330f 35%,#ff6a3d 50%,#e8330f 65%,transparent);' +
    'animation:xcsh-sweep 3.6s ease-in-out infinite alternate}' +
    '@keyframes xcsh-sweep{from{transform:translateX(-13vw)}to{transform:translateX(87vw)}}' +
    '</style>' +
    '<div class="track"><div class="blob"></div></div>';
  document.documentElement.appendChild(scanner);

  // Tiny "terminal effigy": a cartoon of the xcsh TUI brand lockup — the F5 mark
  // beside the "xcsh" wordmark (in the frame red) on a near-black rounded deep-red
  // frame, a compact horizontal rectangle. Rendered in a Shadow DOM so the host
  // page's CSS can never distort the frame, type, or logo.
  //
  // The whole emblem is a single click target that stops the agent — there is no
  // visible button; clicking anywhere on it sends `stop_agent`. It stays
  // pointer-events:none while faded out (see the envelope effects) so the
  // invisible emblem never intercepts page clicks between activity bursts.
  badge = document.createElement('div');
  badge.id = BADGE_ID;
  badge.title = 'Stop xcsh';
  badge.style.cssText =
    'position:fixed;top:8px;right:8px;z-index:2147483647;opacity:0;pointer-events:none;';
  const shadow = badge.attachShadow({ mode: 'open' });
  shadow.innerHTML =
    '<style>' +
    '*{box-sizing:border-box}' +
    `.eff{display:inline-flex;align-items:center;gap:8px;background:#0a0d11;border:1.5px solid ${RED};border-radius:9px;padding:6px 12px 6px 8px;box-shadow:0 3px 12px rgba(0,0,0,.5),0 0 12px rgba(202,38,10,.4);font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;cursor:pointer;transition:border-color 120ms ease-out,box-shadow 120ms ease-out}` +
    `.eff:hover{border-color:#e8330f;box-shadow:0 3px 14px rgba(0,0,0,.55),0 0 18px rgba(202,38,10,.6)}` +
    '.eff img{display:block;width:24px;height:24px}' +
    `.eff .w{font-weight:800;letter-spacing:1px;font-size:15px;text-transform:none;color:${RED}}` +
    '</style>' +
    `<div class="eff"><img alt="F5" src="${F5_LOGO_DATA_URI}"><span class="w">xcsh</span></div>`;
  // Single click receiver: clicking the emblem (anywhere) stops the agent.
  // The click composes out of the Shadow DOM and bubbles to this host listener.
  badge.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'stop_agent' });
  });
  document.documentElement.appendChild(badge);
}

const effects: EnvelopeEffects = {
  onAttack(): void {
    const firstAppearance = scanner === undefined;
    if (firstAppearance) createElements();
    if (!scanner || !badge) return;
    // Force a reflow on first appearance so the opacity:0 → 1 transition animates
    // from the initial state instead of snapping straight to full brightness.
    if (firstAppearance) void scanner.offsetHeight;
    scanner.style.transition = ATTACK;
    scanner.style.opacity = '1';
    badge.style.transition = ATTACK;
    badge.style.opacity = '1';
    badge.style.pointerEvents = 'auto'; // visible emblem is clickable (stop)
  },
  onRelease(): void {
    if (!scanner || !badge) return;
    scanner.style.transition = RELEASE;
    scanner.style.opacity = '0';
    badge.style.transition = RELEASE;
    badge.style.opacity = '0';
    badge.style.pointerEvents = 'none'; // faded-out emblem must not eat clicks
  },
  onCleanup(): void {
    scanner?.remove();
    badge?.remove();
    scanner = undefined;
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
