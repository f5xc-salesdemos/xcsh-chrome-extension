/**
 * Pure helpers for multi-port bridge discovery (Phase 3). Chrome-free and
 * socket-free so it is unit-tested directly; service-worker.ts owns the live
 * WebSocket lifecycle and delegates every decision here.
 */

/** Inclusive loopback discovery range (mirrors xcsh's extension-bridge.ts). */
export const PORT_RANGE_START = 19222;
export const PORT_RANGE_END = 19241;

/** Every port in the discovery range, lowest first. */
export function portCandidates(): number[] {
  const out: number[] = [];
  for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) out.push(p);
  return out;
}

/** Identity a bridge reported via hello_ack, plus liveness bookkeeping. */
export interface BridgeInfo {
  port: number;
  tenant: string | null;
  env: string | null;
  sessionId: string | null;
  /** Epoch ms of the last inbound frame on this socket. */
  lastSeen: number;
}

export type BridgeRegistry = Map<number, BridgeInfo>;

/** sessionKey ("tenant|env") -> port, for every bridge reporting a tenant+env. */
export function tenantToPort(reg: BridgeRegistry): Map<string, number> {
  const out = new Map<string, number>();
  for (const info of reg.values()) {
    if (info.tenant && info.env) out.set(`${info.tenant}|${info.env}`, info.port);
  }
  return out;
}

/** The port serving `sessionKey`, or undefined if no bridge reports it. */
export function portForTenant(reg: BridgeRegistry, sessionKey: string | null): number | undefined {
  if (!sessionKey) return undefined;
  return tenantToPort(reg).get(sessionKey);
}

/** Ports whose last inbound frame is older than `ttlMs` — prune candidates. */
export function stalePorts(reg: BridgeRegistry, now: number, ttlMs: number): number[] {
  const out: number[] = [];
  for (const info of reg.values()) if (now - info.lastSeen > ttlMs) out.push(info.port);
  return out;
}

/** Session keys ("tenant|env") currently backed by a live bridge. */
export function liveTenants(reg: BridgeRegistry): string[] {
  return [...tenantToPort(reg).keys()];
}
