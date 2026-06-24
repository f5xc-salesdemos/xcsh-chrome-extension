/**
 * Pure opacity-envelope state machine for the agent activity indicator.
 *
 * Three phases: ATTACK (snap to full brightness) → HOLD (a minimum dwell at full
 * after the most recent trigger) → RELEASE (gentle, capacitor-style discharge),
 * followed by CLEANUP once the discharge has fully elapsed. A hide that lands
 * inside the hold window is deferred so a brief blip stays lit; a new trigger at
 * any point cancels a pending discharge/cleanup and restarts the hold.
 *
 * All side effects (DOM writes, teardown) and the clock + timers are injected,
 * so this timing logic is deterministically unit-testable with no DOM or globals.
 * `agent-visual-indicator.ts` supplies the real DOM/Chrome effects.
 */

export type TimerId = ReturnType<typeof setTimeout>;

export interface EnvelopeEffects {
  /** Snap to full brightness (the adapter creates elements on first call). */
  onAttack(): void;
  /** Begin the gentle discharge toward invisible. */
  onRelease(): void;
  /** Tear down once the discharge has fully elapsed. */
  onCleanup(): void;
  /** Monotonic clock in ms (e.g. performance.now). */
  now(): number;
  setTimer(fn: () => void, ms: number): TimerId;
  clearTimer(id: TimerId): void;
}

export interface EnvelopeConfig {
  /** Minimum dwell at full brightness after a trigger before discharge begins. */
  holdMs: number;
  /** Delay from the start of release until teardown. */
  cleanupMs: number;
}

export interface Envelope {
  /** A trigger: snap to full and (re)start the hold window. */
  show(): void;
  /** Activity ended: discharge now, or after the rest of the hold window. */
  hide(): void;
}

export function createEnvelope(fx: EnvelopeEffects, cfg: EnvelopeConfig): Envelope {
  let peakAt = 0; // clock time of the most recent snap to full brightness
  let holdTimer: TimerId | undefined;
  let cleanupTimer: TimerId | undefined;

  function beginRelease(): void {
    fx.onRelease();
    if (cleanupTimer !== undefined) fx.clearTimer(cleanupTimer);
    cleanupTimer = fx.setTimer(() => {
      cleanupTimer = undefined;
      fx.onCleanup();
    }, cfg.cleanupMs);
  }

  function show(): void {
    // A pending hold or cleanup means we're already lit (or mid-release); cancel
    // both and snap back to full — a fresh trigger restarts the hold window.
    if (holdTimer !== undefined) {
      fx.clearTimer(holdTimer);
      holdTimer = undefined;
    }
    if (cleanupTimer !== undefined) {
      fx.clearTimer(cleanupTimer);
      cleanupTimer = undefined;
    }
    fx.onAttack();
    peakAt = fx.now();
  }

  function hide(): void {
    if (holdTimer !== undefined) return; // discharge already queued

    // Enforce the minimum hold: if the trigger was less than holdMs ago, defer
    // the discharge until the rest of the window has elapsed.
    const remaining = cfg.holdMs - (fx.now() - peakAt);
    if (remaining > 0) {
      holdTimer = fx.setTimer(() => {
        holdTimer = undefined;
        beginRelease();
      }, remaining);
      return;
    }
    beginRelease();
  }

  return { show, hide };
}
