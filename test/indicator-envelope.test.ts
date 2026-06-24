import { describe, expect, it } from 'bun:test';
import { createEnvelope, type EnvelopeEffects, type TimerId } from '../src/indicator-envelope';

const HOLD = 800;
const CLEANUP = 1500;

/**
 * Deterministic harness: a manual clock + timer queue replaces performance.now
 * and setTimeout/clearTimeout, and the effects record into a log. `advance(ms)`
 * jumps the clock and fires due timers in chronological order (firing one may
 * schedule another, e.g. hold → release → cleanup).
 */
function harness(hold = HOLD, cleanup = CLEANUP) {
  let clock = 0;
  let nextId = 1;
  const timers = new Map<number, { fn: () => void; at: number }>();
  const log: string[] = [];

  const fx: EnvelopeEffects = {
    onAttack: () => log.push('attack'),
    onRelease: () => log.push('release'),
    onCleanup: () => log.push('cleanup'),
    now: () => clock,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, at: clock + ms });
      return id as unknown as TimerId;
    },
    clearTimer: (id) => void timers.delete(id as unknown as number),
  };

  const env = createEnvelope(fx, { holdMs: hold, cleanupMs: cleanup });

  function advance(ms: number): void {
    const target = clock + ms;
    for (;;) {
      // Fire the earliest timer due by `target`, stepping the clock to its fire
      // time first so a callback that schedules another timer (hold → release →
      // cleanup) measures its delay from the correct instant.
      const next = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      clock = next[1].at;
      timers.delete(next[0]);
      next[1].fn();
    }
    clock = target;
  }

  return { env, advance, log, pending: () => timers.size };
}

describe('indicator envelope', () => {
  it('attacks immediately on show', () => {
    const h = harness();
    h.env.show();
    expect(h.log).toEqual(['attack']);
  });

  it('holds at full brightness before discharging when hide lands inside the window', () => {
    const h = harness();
    h.env.show(); // t=0
    h.advance(100); // t=100
    h.env.hide(); // 100ms < 800ms hold → discharge deferred
    expect(h.log).toEqual(['attack']); // NOT releasing yet

    h.advance(699); // t=799, still inside hold
    expect(h.log).toEqual(['attack']);

    h.advance(1); // t=800, hold window elapsed → release begins
    expect(h.log).toEqual(['attack', 'release']);

    h.advance(CLEANUP); // discharge fully elapsed → teardown
    expect(h.log).toEqual(['attack', 'release', 'cleanup']);
  });

  it('discharges immediately when activity already outlasted the hold window', () => {
    const h = harness();
    h.env.show(); // t=0
    h.advance(900); // already lit 900ms > 800ms hold
    h.env.hide();
    expect(h.log).toEqual(['attack', 'release']); // no extra hold
  });

  it('a new trigger during the hold cancels the pending discharge and restarts it', () => {
    const h = harness();
    h.env.show(); // t=0
    h.advance(100);
    h.env.hide(); // schedules discharge at t=800
    h.advance(100); // t=200, still holding
    h.env.show(); // re-trigger → cancels the deferred discharge
    expect(h.log).toEqual(['attack', 'attack']);

    h.advance(5000); // well past the original window
    expect(h.log).toEqual(['attack', 'attack']); // never released
  });

  it('a new trigger during the release cancels cleanup and re-lights', () => {
    const h = harness();
    h.env.show(); // t=0
    h.advance(900);
    h.env.hide(); // immediate release; cleanup scheduled at t=900+1500
    expect(h.log).toEqual(['attack', 'release']);

    h.advance(500); // t=1400, mid-release (before cleanup)
    h.env.show(); // re-trigger → cancels cleanup, snaps back
    expect(h.log).toEqual(['attack', 'release', 'attack']);

    h.advance(5000);
    expect(h.log).toEqual(['attack', 'release', 'attack']); // cleanup never ran
    expect(h.pending()).toBe(0); // no dangling timers
  });

  it('ignores a redundant hide while a discharge is already queued', () => {
    const h = harness();
    h.env.show();
    h.advance(100);
    h.env.hide(); // schedules discharge
    h.env.hide(); // must not double-schedule
    expect(h.pending()).toBe(1);

    h.advance(700); // single release at t=800
    h.advance(CLEANUP);
    expect(h.log).toEqual(['attack', 'release', 'cleanup']);
  });

  it('leaves no dangling timers after a full attack→hold→release→cleanup cycle', () => {
    const h = harness();
    h.env.show();
    h.advance(100);
    h.env.hide();
    h.advance(700 + CLEANUP);
    expect(h.log).toEqual(['attack', 'release', 'cleanup']);
    expect(h.pending()).toBe(0);
  });
});
