import { describe, expect, it } from 'bun:test';
import { extractRedirects, maxGap, pushCapped, summarizeSuspension } from '../src/diagnostics';
import { sessionKeyFromUrl } from '../src/tab-binding';

describe('pushCapped', () => {
  it('drops the oldest entries when over cap', () => {
    const buf: number[] = [];
    for (let i = 0; i < 5; i++) pushCapped(buf, i, 3);
    expect(buf).toEqual([2, 3, 4]);
  });
});

describe('maxGap', () => {
  it('returns 0 for fewer than two timestamps', () => {
    expect(maxGap([])).toBe(0);
    expect(maxGap([1000])).toBe(0);
  });
  it('finds the largest gap (the suspension window) regardless of order', () => {
    // ticks at 0, 20s, 20.02s(??), then a 4-minute sleep, then 260s
    expect(maxGap([0, 20_000, 20_020, 260_000])).toBe(239_980);
    expect(maxGap([260_000, 0, 20_000])).toBe(240_000);
  });
});

describe('summarizeSuspension', () => {
  it('counts restarts, suspends, tick gap, and missed binds (would-bind while WS not open)', () => {
    const summary = summarizeSuspension([
      { t: 0, event: 'sw_start' },
      { t: 1000, event: 'keepalive' },
      { t: 21_000, event: 'keepalive' },
      { t: 25_000, event: 'suspend' },
      { t: 300_000, event: 'sw_start' },
      { t: 301_000, event: 'keepalive' },
      { t: 302_000, event: 'would_bind', wsState: 'closed' }, // missed
      { t: 303_000, event: 'would_bind', wsState: 'open' }, // ok
    ]);
    expect(summary.restarts).toBe(2);
    expect(summary.suspends).toBe(1);
    expect(summary.maxTickGapMs).toBe(280_000); // 21_000 -> 301_000
    expect(summary.missedBinds).toBe(1);
  });
});

describe('extractRedirects', () => {
  it('turns CDP redirectResponse events into an annotated tenant/env chain', () => {
    const events = [
      // console → Keycloak login (302), lands on a tenant realm
      {
        method: 'Network.requestWillBeSent',
        request: { url: 'https://login.ves.volterra.io/auth/realms/acme-x1/protocol/openid-connect/auth' },
        redirectResponse: { url: 'https://acme.console.ves.volterra.io/web/home', status: 302 },
      },
      // a non-redirect event is ignored
      { method: 'Network.responseReceived', response: { url: 'https://acme.console.ves.volterra.io/', status: 200 } },
      // login → back to console (302)
      {
        method: 'Network.requestWillBeSent',
        request: { url: 'https://acme.console.ves.volterra.io/web/home' },
        redirectResponse: { url: 'https://login.ves.volterra.io/auth/realms/acme-x1/protocol/openid-connect/auth', status: 302 },
      },
    ];
    const hops = extractRedirects(events, sessionKeyFromUrl);
    expect(hops).toHaveLength(2);
    expect(hops[0]).toEqual({
      from: 'https://acme.console.ves.volterra.io/web/home',
      to: 'https://login.ves.volterra.io/auth/realms/acme-x1/protocol/openid-connect/auth',
      status: 302,
      toKey: { tenant: 'acme', env: 'production' },
    });
    expect(hops[1].toKey).toEqual({ tenant: 'acme', env: 'production' });
  });
});
