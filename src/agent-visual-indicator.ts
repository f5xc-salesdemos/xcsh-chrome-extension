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
 *
 * The capacitor-style release applies to the badge only. The scanner's activity
 * signal is its back-and-forth sweep, not a decaying glow, so it stays lit and
 * sweeping at full brightness through the whole hold+release window and then
 * leaves with just a brief fade at cleanup (rather than the long exhale).
 */

import { F5_LOGO_DATA_URI } from './f5-logo';
import { createEnvelope, type EnvelopeEffects } from './indicator-envelope';
import { showOverlay } from './overlays';

const SCANNER_ID = '__xcsh-agent-scanner';
const BADGE_ID = '__xcsh-agent-badge';

const RED = '#ca260a'; // xcsh CLI frame red — keeps brand parity with the terminal UI

// Envelope shape — a "breath": a quick organic rise (not a jarring snap), a brief
// hold at full, then a long gentle exhale. A retrigger during the exhale cancels
// the discharge and re-runs onAttack, so the ATTACK transition glides (portamento)
// from the current decayed opacity back to full rather than snapping. The exhale
// (RELEASE) is the badge's capacitor discharge only; the scanner stays at full
// through it and exits with the short SCANNER_EXIT fade at cleanup.
const ATTACK = 'opacity 180ms cubic-bezier(.22,.61,.36,1)'; // rapid, organic breath-in
const HOLD_MS = 600; // minimum dwell at full brightness before the discharge begins
const RELEASE = 'opacity 1800ms ease-out'; // long, gentle exhale (badge capacitor discharge)
const CLEANUP_MS = 1900; // remove from DOM once the release has fully faded (>= RELEASE)
const SCANNER_EXIT = 'opacity 240ms ease-out'; // brief fade so the bar doesn't pop at cleanup
const SCANNER_EXIT_MS = 240; // remove the bar once that fade has elapsed

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
  badge.style.cssText = 'position:fixed;top:8px;right:8px;z-index:2147483647;opacity:0;pointer-events:none;';
  const shadow = badge.attachShadow({ mode: 'open' });
  shadow.innerHTML =
    '<style>' +
    '*{box-sizing:border-box}' +
    `.eff{display:inline-flex;align-items:center;gap:8px;background:#0a0d11;border:1.5px solid ${RED};border-radius:9px;padding:6px 12px 6px 8px;box-shadow:0 6px 16px rgba(0,0,0,.5),0 2px 5px rgba(0,0,0,.45),0 0 12px rgba(202,38,10,.4);font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;cursor:pointer;transition:border-color 120ms ease-out,box-shadow 120ms ease-out}` +
    `.eff:hover{border-color:#e8330f;box-shadow:0 8px 20px rgba(0,0,0,.55),0 2px 6px rgba(0,0,0,.5),0 0 18px rgba(202,38,10,.6)}` +
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
    // The scanner's activity signal is its sweep, not a decaying glow — leave it lit
    // and sweeping through the bridge window; it exits with a brief fade at cleanup.
    // Only the badge does the gentle capacitor discharge.
    badge.style.transition = RELEASE;
    badge.style.opacity = '0';
    badge.style.pointerEvents = 'none'; // faded-out emblem must not eat clicks
  },
  onCleanup(): void {
    badge?.remove(); // already at opacity 0 from the discharge
    // The scanner stayed bright through the bridge/exhale; give it a brief fade so it
    // doesn't pop, then remove. Capture the ref locally — the module var is nulled now,
    // so a fresh show() during the fade builds a new bar while this one self-removes.
    if (scanner) {
      const exiting = scanner;
      exiting.style.transition = SCANNER_EXIT;
      exiting.style.opacity = '0';
      setTimeout(() => exiting.remove(), SCANNER_EXIT_MS);
    }
    scanner = undefined;
    badge = undefined;
  },
  now: () => performance.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (id) => clearTimeout(id),
};

const envelope = createEnvelope(effects, { holdMs: HOLD_MS, cleanupMs: CLEANUP_MS });

chrome.runtime.onMessage.addListener(
  (msg: { type?: string; kind?: string; x?: number; y?: number; w?: number; h?: number }) => {
    if (msg?.type === 'indicator_show') envelope.show();
    if (msg?.type === 'indicator_hide') envelope.hide();
    // Transient overlay annotations (fingerprint, highlight, …) — gated upstream
    // in the service worker so they only arrive during a slow "explain" walkthrough.
    if (msg?.type === 'overlay') showOverlay(msg);
  },
);
