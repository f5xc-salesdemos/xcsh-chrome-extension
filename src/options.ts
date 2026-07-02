/**
 * Options page script — reports live connection status to the xcsh native host
 * and renders the Phase 0a suspension-diagnostics timeline.
 *
 * Pings the service worker via `status_request`; the SW replies with whether
 * its native-messaging port is currently connected.
 */

import { type DiagEvent, summarizeSuspension } from './diagnostics';

// biome-ignore lint/style/noNonNullAssertion: DOM element guaranteed
const el = document.getElementById('status')!;

function render(connected: boolean): void {
  if (connected) {
    el.innerHTML = '<span class="dot green"></span>Connected to xcsh';
  } else {
    el.innerHTML = '<span class="dot red"></span>Not connected — start xcsh and run <code>xcsh chrome setup</code>';
  }
}

chrome.runtime.sendMessage({ type: 'status_request' }, (resp: { connected?: boolean } | undefined) => {
  // A missing response (e.g. SW asleep / runtime error) counts as disconnected.
  if (chrome.runtime.lastError) {
    render(false);
    return;
  }
  render(!!resp?.connected);
});

// --- Phase 0a: suspension-diagnostics timeline -----------------------------
const DIAG_KEY = 'xcsh.diag.suspension';
const summaryEl = document.getElementById('diag-summary');
const eventsEl = document.getElementById('diag-events');

async function renderDiag(): Promise<void> {
  if (!summaryEl || !eventsEl) return;
  const r = await chrome.storage.local.get(DIAG_KEY);
  const events = ((r?.[DIAG_KEY] as DiagEvent[] | undefined) ?? []).slice(-60);
  const s = summarizeSuspension(events);
  summaryEl.textContent = `restarts ${s.restarts} · suspends ${s.suspends} · max tick gap ${(s.maxTickGapMs / 1000).toFixed(1)}s · missed binds ${s.missedBinds}`;
  const t0 = events.length ? events[0].t : 0;
  eventsEl.textContent = events
    .map((e) => {
      const { t, event, ...rest } = e;
      const rel = `+${((t - t0) / 1000).toFixed(1)}s`.padStart(9);
      return `${rel}  ${event.padEnd(16)} ${JSON.stringify(rest)}`;
    })
    .join('\n');
}

document.getElementById('diag-refresh')?.addEventListener('click', () => void renderDiag());
void renderDiag();

// --- Phase 3: discovered bridges table ------------------------------------
interface BridgeRow {
  port: number;
  tenant: string | null;
  env: string | null;
  sessionId: string | null;
  lastSeen: number;
}
async function renderBridges(): Promise<void> {
  const bridgesEl = document.getElementById('bridges');
  if (!bridgesEl) return;
  const resp = await new Promise<{ bridges?: BridgeRow[] } | undefined>((res) =>
    chrome.runtime.sendMessage({ type: 'bridges_request' }, (r) => res(chrome.runtime.lastError ? undefined : r)),
  );
  const rows = resp?.bridges ?? [];
  bridgesEl.textContent = rows.length
    ? rows.map((b) => `:${b.port}  ${b.tenant ?? '—'}·${b.env ?? '—'}  ${b.sessionId ?? ''}`).join('\n')
    : '(none)';
}
void renderBridges();
document.getElementById('diag-refresh')?.addEventListener('click', () => void renderBridges());
