/**
 * Page-context snapshot — the "what the user is looking at" payload attached to
 * every chat turn. PURE: takes plain inputs (url/title + an AX tree + a captured
 * API body) and produces a budgeted, secret-redacted snapshot. The SW gathers
 * the raw inputs; this module owns all trimming so it is unit-testable.
 */

export interface AxLike {
  role: string;
  name?: string;
  ref?: string;
  children?: AxLike[];
  [k: string]: unknown;
}

export interface RawApiCapture {
  url: string;
  status: number;
  resourceType: string | null;
  body: unknown;
}

export interface SnapshotInputs {
  tabId: number;
  url: string;
  title: string;
  capturedAt: number;
  ax: AxLike | null;
  api: RawApiCapture | null;
}

export interface SnapshotApi {
  url: string;
  status: number;
  resourceType: string | null;
  body: unknown;
  truncated: boolean;
}

export interface PageContextSnapshot {
  v: 1;
  capturedAt: number;
  tabId: number;
  url: string;
  path: string;
  title: string;
  ax: AxLike | null;
  api: SnapshotApi | null;
  truncated: boolean;
}

export interface SnapshotMeta {
  url: string;
  path: string;
  title: string;
  axBytes: number;
  apiBytes: number;
}

export const SNAPSHOT_CAPS = {
  total: 64 * 1024,
  ax: 12 * 1024,
  apiBody: 40 * 1024,
  axDepth: 12,
  axNodes: 400,
};

const SECRET_KEY = /^(token|password|secret|authorization|cookie|bearer|credentials)$|(_key|_token|_secret)$/i;

export function redactSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : redactSecrets(v);
    }
    return out as T;
  }
  return value;
}

function bytes(v: unknown): number {
  return v == null ? 0 : JSON.stringify(v).length;
}

/** Keep role/name/ref + children, capped by depth and a global node budget. */
function trimAx(node: AxLike, caps: typeof SNAPSHOT_CAPS): { ax: AxLike; truncated: boolean } {
  let budget = caps.axNodes;
  let truncated = false;
  const walk = (n: AxLike, depth: number): AxLike => {
    const out: AxLike = { role: n.role };
    if (n.name) out.name = n.name;
    if (n.ref) out.ref = n.ref;
    const kids = n.children ?? [];
    if (depth >= caps.axDepth) {
      if (kids.length) truncated = true;
      return out;
    }
    const keep: AxLike[] = [];
    for (const c of kids) {
      if (budget <= 0) {
        truncated = true;
        break;
      }
      budget--;
      keep.push(walk(c, depth + 1));
    }
    if (keep.length) out.children = keep;
    return out;
  };
  budget--; // count the root
  return { ax: walk(node, 0), truncated };
}

/** Shallow-keep top-level keys + metadata/spec when a body busts its budget. Assumes body has already been redacted by redactSecrets(). */
function trimApiBody(body: unknown, maxBytes: number): { body: unknown; truncated: boolean } {
  if (bytes(body) <= maxBytes) return { body, truncated: false };
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const src = body as Record<string, unknown>;
    const shallow: Record<string, unknown> = {};
    for (const k of ['metadata', 'spec', 'name', 'namespace', 'kind']) {
      if (k in src) shallow[k] = src[k];
    }
    if (bytes(shallow) <= maxBytes) return { body: shallow, truncated: true };
  }
  return { body: { note: '[body too large]' }, truncated: true };
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

/**
 * Return only origin + pathname of `raw`, dropping any query string and hash.
 * This prevents tokens that appear in OIDC redirect URLs (e.g. ?access_token=…)
 * from being forwarded to the bridge inside a page-context snapshot.
 * Falls back to stripping from the first `?` or `#` when `new URL` fails.
 */
export function sanitizeUrl(raw: string): string {
  try {
    const { origin, pathname } = new URL(raw);
    return origin + pathname;
  } catch {
    // Strip from whichever delimiter appears first
    const q = raw.indexOf('?');
    const h = raw.indexOf('#');
    const cut = q === -1 ? h : h === -1 ? q : Math.min(q, h);
    return cut === -1 ? raw : raw.slice(0, cut);
  }
}

export function buildContextSnapshot(
  inputs: SnapshotInputs,
  caps: typeof SNAPSHOT_CAPS = SNAPSHOT_CAPS,
): PageContextSnapshot {
  let truncated = false;

  let ax: AxLike | null = null;
  if (inputs.ax) {
    const t = trimAx(redactSecrets(inputs.ax), caps);
    ax = t.ax;
    truncated ||= t.truncated;
    if (bytes(ax) > caps.ax) {
      ax = { role: inputs.ax.role };
      truncated = true;
    }
  }

  let api: SnapshotApi | null = null;
  if (inputs.api) {
    const tb = trimApiBody(redactSecrets(inputs.api.body), caps.apiBody);
    api = {
      url: inputs.api.url,
      status: inputs.api.status,
      resourceType: inputs.api.resourceType,
      body: tb.body,
      truncated: tb.truncated,
    };
    truncated ||= tb.truncated;
  }

  const snap: PageContextSnapshot = {
    v: 1,
    capturedAt: inputs.capturedAt,
    tabId: inputs.tabId,
    url: sanitizeUrl(inputs.url),
    path: pathOf(inputs.url),
    title: inputs.title,
    ax,
    api,
    truncated,
  };

  // Enforce the overall budget: drop ax first (largest, least precise), then
  // collapse the api body, then drop it entirely.
  if (JSON.stringify(snap).length > caps.total && snap.ax) {
    snap.ax = null;
    snap.truncated = true;
  }
  if (JSON.stringify(snap).length > caps.total && snap.api) {
    snap.api = { ...snap.api, body: { note: '[body dropped: over budget]' }, truncated: true };
    snap.truncated = true;
  }
  if (JSON.stringify(snap).length > caps.total && snap.api) {
    snap.api = null;
    snap.truncated = true;
  }

  return snap;
}

export function snapshotMetadata(s: PageContextSnapshot): SnapshotMeta {
  return { url: s.url, path: s.path, title: s.title, axBytes: bytes(s.ax), apiBytes: bytes(s.api) };
}
