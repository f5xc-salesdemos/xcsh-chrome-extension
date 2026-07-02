/**
 * Pure diagnostics helpers for Phase 0 investigation — Chrome-free and DOM-free
 * so they unit-test in isolation. The service worker records events into a
 * capped ring buffer (SW (re)start, suspend/canceled, keepalive ticks, WS
 * open/close, would-bind activations) and exposes them via the `diag_suspension`
 * tool; `capture_login_flow` uses `extractRedirects` to turn captured CDP
 * network events into an annotated redirect chain for login-topology analysis.
 */

/** A single timestamped diagnostics record. */
export interface DiagEvent {
  /** Epoch ms. */
  t: number;
  /** Event kind, e.g. "sw_start", "suspend", "keepalive", "ws_open", "would_bind". */
  event: string;
  /** Arbitrary structured detail (wsState, tabId, url, tenant, …). */
  [k: string]: unknown;
}

/** Push onto a ring buffer, dropping the oldest when over `cap` (in place). */
export function pushCapped<T>(buf: T[], item: T, cap: number): void {
  buf.push(item);
  while (buf.length > cap) buf.shift();
}

/**
 * Largest gap between consecutive timestamps — the MV3 suspension window when
 * applied to keepalive-tick times (a tick every ~20s should keep the max gap
 * near 20s; a large gap means the SW slept). Returns 0 for < 2 timestamps.
 */
export function maxGap(timestamps: number[]): number {
  if (timestamps.length < 2) return 0;
  const sorted = [...timestamps].sort((a, b) => a - b);
  let max = 0;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap > max) max = gap;
  }
  return max;
}

export interface SuspensionSummary {
  /** Count of SW (re)starts recorded. */
  restarts: number;
  /** Count of onSuspend events. */
  suspends: number;
  /** Largest gap between keepalive ticks (ms) — the observed suspension window. */
  maxTickGapMs: number;
  /** would-bind activations that fired while the WS was not open (proxy for missed binds). */
  missedBinds: number;
}

/** Summarize a diagnostics buffer into the numbers we care about for Phase 0a. */
export function summarizeSuspension(events: DiagEvent[]): SuspensionSummary {
  const tickTimes = events.filter(e => e.event === 'keepalive').map(e => e.t);
  const missedBinds = events.filter(
    e => e.event === 'would_bind' && e.wsState !== 'open',
  ).length;
  return {
    restarts: events.filter(e => e.event === 'sw_start').length,
    suspends: events.filter(e => e.event === 'suspend').length,
    maxTickGapMs: maxGap(tickTimes),
    missedBinds,
  };
}

/** One hop in a captured redirect chain, annotated with the resolved session key. */
export interface RedirectHop {
  from: string;
  to: string;
  status: number;
  /** `sessionKeyFromUrl(to)` — the tenant/env the hop lands on, or null. */
  toKey: { tenant: string; env: 'production' | 'staging' } | null;
}

/**
 * Extract the redirect chain from captured CDP network events. Chrome signals a
 * redirect via `Network.requestWillBeSent` carrying a `redirectResponse` (the
 * 3xx that caused the new request); `from` = that response's URL, `to` = the new
 * request URL. Each hop's landing URL is annotated via the injected
 * `sessionKey` resolver (dependency-injected to keep this module pure).
 */
export function extractRedirects(
  events: Array<Record<string, unknown>>,
  sessionKey: (url: string | undefined) => { tenant: string; env: 'production' | 'staging' } | null,
): RedirectHop[] {
  const hops: RedirectHop[] = [];
  for (const e of events) {
    if (e.method !== 'Network.requestWillBeSent') continue;
    const rr = e.redirectResponse as { url?: string; status?: number } | undefined;
    if (!rr) continue;
    const from = rr.url;
    const req = e.request as { url?: string } | undefined;
    const to = req?.url ?? (e.documentURL as string | undefined);
    if (!from || !to) continue;
    hops.push({ from, to, status: rr.status ?? 0, toKey: sessionKey(to) });
  }
  return hops;
}
