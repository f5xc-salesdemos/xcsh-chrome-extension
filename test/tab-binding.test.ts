import { describe, expect, it } from 'bun:test';
import {
  bindIsDisruptive,
  decideBinding,
  isConsoleUrl,
  isLinkStale,
  isSameTabRebind,
  sessionKeyFromUrl,
  sessionKeyStr,
  shouldAnnounceBind,
} from '../src/tab-binding';

const CONSOLE = 'https://acme.console.ves.volterra.io/web/x';
const CONSOLE2 = 'https://acme.staging.volterra.us/web/y';
const OTHER = 'https://example.com/';

describe('isConsoleUrl', () => {
  it('matches volterra.us and console.ves.volterra.io https', () => {
    expect(isConsoleUrl(CONSOLE)).toBe(true);
    expect(isConsoleUrl(CONSOLE2)).toBe(true);
  });
  it('rejects other hosts, http, and undefined', () => {
    expect(isConsoleUrl(OTHER)).toBe(false);
    expect(isConsoleUrl('http://acme.volterra.us/')).toBe(false);
    expect(isConsoleUrl(undefined)).toBe(false);
  });
});

describe('decideBinding', () => {
  const idle = (controlledTabId: number | undefined) => ({ controlledTabId, inFlight: false });

  it('binds when a different console tab is activated while idle', () => {
    expect(decideBinding(idle(undefined), { kind: 'activated', tabId: 5, url: CONSOLE })).toEqual({
      action: 'bind',
      tabId: 5,
    });
    expect(decideBinding(idle(3), { kind: 'activated', tabId: 5, url: CONSOLE })).toEqual({ action: 'bind', tabId: 5 });
  });
  it('keeps when the already-bound console tab is re-activated', () => {
    expect(decideBinding(idle(5), { kind: 'activated', tabId: 5, url: CONSOLE })).toEqual({ action: 'keep' });
  });
  it('never rebinds while in-flight (automation wins)', () => {
    expect(
      decideBinding({ controlledTabId: 3, inFlight: true }, { kind: 'activated', tabId: 5, url: CONSOLE }),
    ).toEqual({ action: 'keep' });
  });
  it('activating a non-console tab keeps an existing binding, else inactive', () => {
    expect(decideBinding(idle(3), { kind: 'activated', tabId: 9, url: OTHER })).toEqual({ action: 'keep' });
    expect(decideBinding(idle(undefined), { kind: 'activated', tabId: 9, url: OTHER })).toEqual({ action: 'inactive' });
  });
  it('unbinds when the bound tab navigates to a non-console url', () => {
    expect(decideBinding(idle(5), { kind: 'updated', tabId: 5, url: OTHER })).toEqual({ action: 'unbind' });
    expect(decideBinding(idle(5), { kind: 'updated', tabId: 5, url: CONSOLE })).toEqual({ action: 'keep' });
    expect(decideBinding(idle(5), { kind: 'updated', tabId: 7, url: OTHER })).toEqual({ action: 'keep' });
  });
  it('unbinds when the bound tab is removed', () => {
    expect(decideBinding(idle(5), { kind: 'removed', tabId: 5 })).toEqual({ action: 'unbind' });
    expect(decideBinding(idle(5), { kind: 'removed', tabId: 7 })).toEqual({ action: 'keep' });
  });
});

describe('shouldAnnounceBind', () => {
  // The SW broadcasts `tab_bound` (an ownership-change event that ends the
  // panel's current turn + swaps session) only when the controlled tab actually
  // changes. Re-navigating the already-bound tab — which the agent does as the
  // first step of every workflow — must NOT re-announce, or the panel blanks
  // mid-turn.
  it('announces the first bind (prev undefined)', () => {
    expect(shouldAnnounceBind(undefined, 5)).toBe(true);
  });
  it('announces a switch to a different tab', () => {
    expect(shouldAnnounceBind(3, 5)).toBe(true);
  });
  it('does NOT announce re-navigation of the already-bound tab', () => {
    expect(shouldAnnounceBind(5, 5)).toBe(false);
  });
});

describe('isSameTabRebind', () => {
  // Panel-side defense-in-depth: an inbound `tab_bound` for the tab we already
  // own is a redundant re-bind (e.g. the agent navigated our own tab), not a
  // user tab-switch — so the panel must refresh context only, never abort the
  // active turn or swap session.
  it('is true when the inbound bind targets the already-bound tab', () => {
    expect(isSameTabRebind(5, 5)).toBe(true);
  });
  it('is false for a different tab', () => {
    expect(isSameTabRebind(7, 5)).toBe(false);
  });
  it('is false when no tab is bound yet (initial bind is disruptive)', () => {
    expect(isSameTabRebind(5, undefined)).toBe(false);
  });
});

describe('bindIsDisruptive', () => {
  // A `tab_bound` is disruptive (abort the in-flight turn + swap session) ONLY
  // for a genuine user tab-switch while idle. A same-tab rebind, or ANY bind
  // during an in-flight turn (the automation binding its own tab — including the
  // FIRST bind, when the flagship flow starts on an unbound tab), must be
  // adopted without aborting, or the transcript blanks the moment automation
  // starts.
  it('adopts (non-disruptive) a first bind that happens during an active turn', () => {
    expect(bindIsDisruptive(5, undefined, true)).toBe(false);
  });
  it('adopts (non-disruptive) any bind during an active turn', () => {
    expect(bindIsDisruptive(7, 5, true)).toBe(false);
  });
  it('is non-disruptive for a same-tab rebind even with no active turn', () => {
    expect(bindIsDisruptive(5, 5, false)).toBe(false);
  });
  it('is disruptive for a genuine tab-switch while idle', () => {
    expect(bindIsDisruptive(7, 5, false)).toBe(true);
  });
  it('is disruptive for the initial bind at idle (loads that tab session)', () => {
    expect(bindIsDisruptive(5, undefined, false)).toBe(true);
  });
});

describe('sessionKeyFromUrl', () => {
  // The session identity: (tenant, env) from a console/login URL. STRICTER and
  // fail-closed vs isConsoleUrl — an unrecognized host must yield null so a tab
  // never activates against the wrong (or a shared) session. Staging and
  // production of the same tenant name stay DISTINCT keys.
  it('keys a staging tenant console by (tenant, staging)', () => {
    expect(sessionKeyFromUrl('https://nferreira.staging.volterra.us/web/home')).toEqual({
      tenant: 'nferreira',
      env: 'staging',
    });
  });
  it('keys a production tenant console by (tenant, production)', () => {
    expect(sessionKeyFromUrl('https://acme.console.ves.volterra.io/web/x')).toEqual({
      tenant: 'acme',
      env: 'production',
    });
  });
  it('separates staging vs production of the same tenant name', () => {
    const s = sessionKeyFromUrl('https://acme.staging.volterra.us/web/home');
    const p = sessionKeyFromUrl('https://acme.console.ves.volterra.io/web/home');
    expect(s).toEqual({ tenant: 'acme', env: 'staging' });
    expect(p).toEqual({ tenant: 'acme', env: 'production' });
    expect(s).not.toEqual(p);
  });
  it('maps a tenant-realm Keycloak login to that tenant (provisional; refined by 0b)', () => {
    expect(sessionKeyFromUrl('https://login.ves.volterra.io/auth/realms/acme-abc123/protocol/openid-connect/auth')).toEqual({
      tenant: 'acme',
      env: 'production',
    });
  });
  it('fails closed on the shared SaaS console and shared realm', () => {
    expect(sessionKeyFromUrl('https://console.ves.volterra.io/web/devportal/domain')).toBeNull();
    expect(sessionKeyFromUrl('https://login.ves.volterra.io/auth/realms/volterra/protocol/openid-connect/auth')).toBeNull();
  });
  it('fails closed on non-console hosts, IPs, bare volterra hosts, and junk', () => {
    expect(sessionKeyFromUrl('https://example.com/')).toBeNull();
    expect(sessionKeyFromUrl('https://192.168.1.10/web/home')).toBeNull();
    expect(sessionKeyFromUrl('https://foo.volterra.us/web/home')).toBeNull();
    expect(sessionKeyFromUrl('not a url')).toBeNull();
    expect(sessionKeyFromUrl(undefined)).toBeNull();
  });
});

describe('sessionKeyStr', () => {
  it('renders a stable "tenant|env" string key', () => {
    expect(sessionKeyStr({ tenant: 'acme', env: 'staging' })).toBe('acme|staging');
    expect(sessionKeyStr({ tenant: 'acme', env: 'production' })).toBe('acme|production');
  });
  it('round-trips from a URL', () => {
    const key = sessionKeyFromUrl('https://nferreira.staging.volterra.us/web/home');
    expect(key && sessionKeyStr(key)).toBe('nferreira|staging');
  });
});

describe('isLinkStale', () => {
  it('is stale only after more than intervalMs of silence', () => {
    expect(isLinkStale(1000, 1000 + 45_000, 45_000)).toBe(false);
    expect(isLinkStale(1000, 1000 + 45_001, 45_000)).toBe(true);
  });
});
