/**
 * Overlay-annotation library — transient, fire-and-forget visual cues drawn on
 * the page (a fingerprint at a click, a highlight around an element, …). Each is
 * an isolated, self-removing Shadow-DOM overlay, so it neither depends on nor
 * disturbs the host page's CSS.
 *
 * Two layers, mirroring `indicator-envelope`:
 *   - `planOverlay(spec)` is PURE — kind → host position + inner markup + the
 *     per-element Web-Animations keyframes. No DOM; deterministically unit-tested.
 *   - `showOverlay(spec)` is the thin DOM adapter: mount the plan in a Shadow DOM,
 *     run the animations, and self-remove when they finish.
 *
 * Add a new annotation by adding a `kind` to `planOverlay`; the dispatch, Shadow
 * DOM mounting, animation, and cleanup are all shared.
 */

const RED = '#ca260a'; // F5 / xcsh red
const RING_BLUE = '#2f80ed'; // click ripple
const HIGHLIGHT_PAD = 4; // px of breathing room the highlight leaves around the target

/** Annotation request. `kind` selects the renderer; the rest are kind-specific. */
export type OverlaySpec =
  | { kind: 'fingerprint'; x?: number; y?: number }
  | { kind: 'highlight'; x?: number; y?: number; w?: number; h?: number }
  | { kind: 'callout'; x?: number; y?: number; text?: string }
  // Permissive fallthrough so a message from the wire is assignable; unknown
  // kinds resolve to `null` in `planOverlay`.
  | { kind?: string; [k: string]: unknown };

/** Keyframes as plain objects (kept DOM-type-free so the plan stays portable). */
type Frames = Array<Record<string, string | number>>;

export interface OverlayAnim {
  /** Selector for the element within the overlay's shadow root. */
  sel: string;
  keyframes: Frames;
  timing: { duration: number; easing: string };
}

export interface OverlayPlan {
  /** Fixed viewport position of the overlay host (CSS px). */
  left: number;
  top: number;
  /** Shadow-root markup (self-contained, inline-styled). */
  html: string;
  anims: OverlayAnim[];
  /** Safety-net lifetime; host is removed by this long after mount regardless. */
  ttlMs: number;
}

const FINGERPRINT_SVG =
  `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="${RED}" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" style="position:absolute;left:0;top:0;margin:-18px 0 0 -18px;filter:drop-shadow(0 0 1px #fff) drop-shadow(0 0 1px #fff) drop-shadow(0 0 3px rgba(202,38,10,.4))">` +
  '<path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4"/><path d="M14 13.12c0 2.38 0 6.38-1 8.88"/><path d="M17.29 21.02c.12-.6.43-2.3.5-3.02"/><path d="M2 12a10 10 0 0 1 18-6"/><path d="M2 16h.01"/><path d="M21.8 16c.2-2 .131-5.354 0-6"/><path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2"/><path d="M8.65 22c.21-.66.45-1.32.57-2"/><path d="M9 6.8a6 6 0 0 1 9 5.2v2"/></svg>';

function finite(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Pure: turn an overlay request into a render plan, or `null` if the kind is
 * unknown or the geometry is invalid.
 */
export function planOverlay(spec: OverlaySpec): OverlayPlan | null {
  const s = spec as Record<string, unknown>;
  const kind = typeof s.kind === 'string' ? s.kind : undefined;

  if (kind === 'fingerprint') {
    const x = finite(s.x);
    const y = finite(s.y);
    if (x === undefined || y === undefined) return null;
    const html =
      `<div class="ring" style="position:absolute;left:0;top:0;width:40px;height:40px;margin:-20px 0 0 -20px;border-radius:50%;border:2px solid ${RING_BLUE};filter:drop-shadow(0 0 4px rgba(47,128,237,.65))"></div>` +
      FINGERPRINT_SVG;
    return {
      left: x,
      top: y,
      html,
      anims: [
        {
          sel: '.ring',
          keyframes: [
            { opacity: 0, transform: 'scale(.35)' },
            { opacity: 0.7, offset: 0.12 },
            { opacity: 0, transform: 'scale(2.9)' },
          ],
          timing: { duration: 850, easing: 'ease-out' },
        },
        {
          sel: 'svg',
          keyframes: [
            { opacity: 0, transform: 'scale(.45)' },
            { opacity: 1, transform: 'scale(1)', offset: 0.14 },
            { opacity: 1, transform: 'scale(1)', offset: 0.42 },
            { opacity: 0, transform: 'scale(1.32)' },
          ],
          timing: { duration: 850, easing: 'ease-in-out' },
        },
      ],
      ttlMs: 950,
    };
  }

  if (kind === 'highlight') {
    const x = finite(s.x);
    const y = finite(s.y);
    const w = finite(s.w);
    const h = finite(s.h);
    if (x === undefined || y === undefined || w === undefined || h === undefined) return null;
    if (w <= 0 || h <= 0) return null;
    const bw = w + HIGHLIGHT_PAD * 2;
    const bh = h + HIGHLIGHT_PAD * 2;
    const html = `<div class="box" style="position:absolute;left:0;top:0;width:${bw}px;height:${bh}px;box-sizing:border-box;border:2px solid ${RED};border-radius:6px;box-shadow:0 0 0 1px rgba(202,38,10,.25),0 0 10px 2px rgba(202,38,10,.45);background:rgba(202,38,10,.06)"></div>`;
    return {
      left: x - HIGHLIGHT_PAD,
      top: y - HIGHLIGHT_PAD,
      html,
      anims: [
        {
          sel: '.box',
          // scale-in, then two opacity pulses, then fade — a calm "look here".
          keyframes: [
            { opacity: 0, transform: 'scale(.97)' },
            { opacity: 1, transform: 'scale(1)', offset: 0.12 },
            { opacity: 0.4, offset: 0.4 },
            { opacity: 1, offset: 0.62 },
            { opacity: 0.4, offset: 0.82 },
            { opacity: 0, transform: 'scale(1.01)' },
          ],
          timing: { duration: 1500, easing: 'ease-in-out' },
        },
      ],
      ttlMs: 1600,
    };
  }

  if (kind === 'callout') {
    const x = finite(s.x);
    const y = finite(s.y);
    const text = typeof s.text === 'string' ? s.text : '';
    if (x === undefined || y === undefined || text.length === 0) return null;
    // Position the callout above the target (offset up by ~40px so it doesn't
    // cover what it's pointing at). Escape HTML to avoid injection.
    const safeText = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const html = `<div class="callout" style="position:absolute;left:0;top:0;transform:translateX(-50%);max-width:280px;padding:8px 12px;border-radius:8px;background:#0a0d11;border:1.5px solid ${RED};box-shadow:0 3px 14px rgba(0,0,0,.5),0 0 10px rgba(202,38,10,.4);color:#e8ecf4;font:600 13px/1.4 'JetBrains Mono',ui-monospace,Menlo,monospace;white-space:pre-wrap;pointer-events:none">${safeText}</div>`;
    return {
      left: x,
      top: y - 44, // above the target
      html,
      anims: [
        {
          sel: '.callout',
          keyframes: [
            { opacity: 0, transform: 'translateX(-50%) translateY(8px)' },
            { opacity: 1, transform: 'translateX(-50%) translateY(0)', offset: 0.12 },
            { opacity: 1, transform: 'translateX(-50%) translateY(0)', offset: 0.7 },
            { opacity: 0, transform: 'translateX(-50%) translateY(-4px)' },
          ],
          timing: { duration: 2200, easing: 'ease-in-out' },
        },
      ],
      ttlMs: 2400,
    };
  }

  return null;
}

/**
 * Mount an overlay and animate it. Each call creates a fresh, isolated host that
 * removes itself when the animation finishes (with a `ttlMs` safety net so a
 * cancelled/absent animation can never leak a node).
 */
export function showOverlay(spec: OverlaySpec): void {
  const plan = planOverlay(spec);
  if (!plan) return;

  const host = document.createElement('div');
  host.style.cssText = `position:fixed;left:${plan.left}px;top:${plan.top}px;z-index:2147483647;pointer-events:none;`;
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = plan.html;
  document.documentElement.appendChild(host);

  let last: Animation | undefined;
  for (const a of plan.anims) {
    const el = root.querySelector(a.sel);
    if (!el || typeof el.animate !== 'function') continue;
    last = el.animate(a.keyframes as Keyframe[], a.timing);
  }
  if (last) {
    last.onfinish = () => host.remove();
    last.oncancel = () => host.remove();
  }
  // Safety net: always clean up by ttl, even if animations are unavailable or a
  // non-final animation outlived `last`. remove() is idempotent.
  setTimeout(() => host.remove(), plan.ttlMs);
}
