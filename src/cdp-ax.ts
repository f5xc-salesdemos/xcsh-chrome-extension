/**
 * CDP-based accessibility tree + acting.
 *
 * Reads the page's accessibility tree via `chrome.debugger`'s
 * `Accessibility.getFullAXTree` — the SAME computed AX tree that xcsh's CDP
 * path (Puppeteer `accessibility.snapshot()`) produces. This gives the
 * extension byte-identical AX semantics to the validated console catalogue, so
 * every catalogue selector (`text('…')`, `role:text('…')`, `textbox[name='…']`)
 * resolves deterministically — unlike a DOM-walk approximation.
 *
 * Nodes carry a `ref` = the CDP `backendDOMNodeId` (stable), which the act layer
 * resolves to coordinates (click/scroll) or an object handle (fill/select).
 */

export interface CdpAxNode {
  role: string;
  name: string;
  ref?: string;
  children: CdpAxNode[];
}

type Target = { tabId: number };

// biome-ignore lint/suspicious/noExplicitAny: CDP protocol types
function send(target: Target, method: string, params: Record<string, unknown> = {}): Promise<any> {
  return chrome.debugger.sendCommand(target, method, params);
}

// Roles that carry no semantic value for selector matching — flattened away
// (their named descendants are promoted) to keep the serialized tree small.
const NOISE_ROLES = new Set(['none', 'presentation', 'generic', 'GenericContainer', 'InlineTextBox', 'LineBreak', '']);

interface RawAxNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: unknown };
  childIds?: string[];
  backendDOMNodeId?: number;
}

/** Build the AX tree via CDP, pruned to matchable nodes. Caller must have attached the debugger. */
export async function readAxTree(tabId: number): Promise<CdpAxNode> {
  const target = { tabId };
  await send(target, 'DOM.enable');
  const { nodes } = (await send(target, 'Accessibility.getFullAXTree')) as { nodes: RawAxNode[] };
  const byId = new Map<string, RawAxNode>();
  for (const n of nodes) byId.set(n.nodeId, n);

  const seen = new Set<string>();

  // Collect the matchable descendants of a node, flattening noise nodes so the
  // tree keeps only nodes with a real role or an accessible name.
  const childrenOf = (n: RawAxNode): CdpAxNode[] => {
    const out: CdpAxNode[] = [];
    for (const cid of n.childIds ?? []) {
      const child = byId.get(cid);
      if (!child || seen.has(cid)) continue;
      seen.add(cid);
      const role = child.role?.value ?? '';
      const name = typeof child.name?.value === 'string' ? child.name.value : '';
      const interesting = !child.ignored && (!NOISE_ROLES.has(role) || name.length > 0);
      if (interesting) {
        out.push({
          role,
          name,
          ref: child.backendDOMNodeId != null ? String(child.backendDOMNodeId) : undefined,
          children: childrenOf(child),
        });
      } else {
        // Flatten: promote this node's matchable descendants up to the parent.
        out.push(...childrenOf(child));
      }
    }
    return out;
  };

  const childIdSet = new Set<string>();
  for (const n of nodes) for (const c of n.childIds ?? []) childIdSet.add(c);
  const root = nodes.find((n) => !childIdSet.has(n.nodeId)) ?? nodes[0];
  if (!root) throw new Error('read_ax: empty accessibility tree');
  seen.add(root.nodeId);
  return {
    role: root.role?.value ?? 'RootWebArea',
    name: typeof root.name?.value === 'string' ? root.name.value : '',
    ref: root.backendDOMNodeId != null ? String(root.backendDOMNodeId) : undefined,
    children: childrenOf(root),
  };
}

/** Clickable center from the renderer's layout: largest visible content quad,
 * falling back to the box model. CSS viewport px — the space Input.* consumes. */
async function backendCenter(tabId: number, backendNodeId: number): Promise<{ x: number; y: number }> {
  const target = { tabId };
  try {
    await send(target, 'DOM.scrollIntoViewIfNeeded', { backendNodeId });
  } catch {
    /* best-effort: some nodes can't scroll, geometry may still be valid */
  }
  const { quads } = (await send(target, 'DOM.getContentQuads', { backendNodeId }).catch(() => ({
    quads: [] as number[][],
  }))) as { quads: number[][] };
  let best: number[] | undefined;
  let bestArea = 0;
  for (const q of quads ?? []) {
    const a =
      Math.abs(
        q[0] * q[3] - q[2] * q[1] + (q[2] * q[5] - q[4] * q[3]) + (q[4] * q[7] - q[6] * q[5]) + (q[6] * q[1] - q[0] * q[7]),
      ) / 2;
    if (a > bestArea) {
      bestArea = a;
      best = q;
    }
  }
  if (best && bestArea > 1) return { x: (best[0] + best[4]) / 2, y: (best[1] + best[5]) / 2 };
  const { model } = (await send(target, 'DOM.getBoxModel', { backendNodeId })) as { model: { content: number[] } };
  const c = model.content; // [x1,y1, x2,y2, x3,y3, x4,y4]
  return { x: (c[0] + c[4]) / 2, y: (c[1] + c[5]) / 2 };
}

function backendId(ref: string): number {
  const id = Number(ref);
  if (!Number.isFinite(id)) throw new Error(`invalid ref: ${ref}`);
  return id;
}

export async function clickRef(tabId: number, ref: string): Promise<{ x: number; y: number }> {
  const target = { tabId };
  const backendNodeId = backendId(ref);
  const { x, y } = await backendCenter(tabId, backendNodeId);
  // Hit-test: verify the point resolves to the target before dispatching.
  const objectId = await resolveObject(tabId, ref);
  const verdict = (
    (await send(target, 'Runtime.callFunctionOn', {
      objectId,
      returnByValue: true,
      functionDeclaration: `function(cx,cy){var h=document.elementFromPoint(cx,cy);return !h?'none':(h===this||this.contains(h)||h.contains(this))?'hit':'occluded:'+(h.tagName||'');}`,
      arguments: [{ value: x }, { value: y }],
    })) as { result?: { value?: string } }
  ).result?.value;
  await send(target, 'Runtime.releaseObject', { objectId }).catch(() => {});
  if (verdict !== 'hit') throw new Error(`clickRef: ref ${ref} not hittable — point (${Math.round(x)},${Math.round(y)}) ${verdict}`);
  await send(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  return { x, y };
}

export async function scrollRef(tabId: number, ref: string): Promise<void> {
  await send({ tabId }, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: backendId(ref) });
}

async function resolveObject(tabId: number, ref: string): Promise<string> {
  const { object } = (await send({ tabId }, 'DOM.resolveNode', { backendNodeId: backendId(ref) })) as {
    object: { objectId: string };
  };
  return object.objectId;
}

// commitInputValue (xcsh parity): walk the prototype chain for the native value
// setter (bypasses framework-patched descriptors), then fire input/change/blur/
// focusout so Angular `updateOn:'blur'` vsui-input controls commit.
const COMMIT_FN = `function(value){
  this.focus && this.focus();
  let d, p = Object.getPrototypeOf(this);
  while (p) { d = Object.getOwnPropertyDescriptor(p, 'value'); if (d) break; p = Object.getPrototypeOf(p); }
  if (d && d.set) d.set.call(this, value); else this.value = value;
  this.dispatchEvent(new Event('input', {bubbles:true}));
  this.dispatchEvent(new Event('change', {bubbles:true}));
  this.dispatchEvent(new Event('blur', {bubbles:false}));
  this.dispatchEvent(new Event('focusout', {bubbles:true}));
}`;

export async function formInputRef(tabId: number, ref: string, value: string): Promise<void> {
  const objectId = await resolveObject(tabId, ref);
  await send({ tabId }, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: COMMIT_FN,
    arguments: [{ value }],
  });
}

export async function selectOptionRef(tabId: number, ref: string, value: string): Promise<boolean> {
  const objectId = await resolveObject(tabId, ref);
  const r = (await send({ tabId }, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function(value){
      const opts = Array.from(this.options || []);
      const opt = opts.find(o => o.value === value || o.text === value);
      if (!opt) return false;
      this.value = opt.value;
      this.dispatchEvent(new Event('change', {bubbles:true}));
      return true;
    }`,
    arguments: [{ value }],
    returnByValue: true,
  })) as { result?: { value?: boolean } };
  return r?.result?.value === true;
}

export async function innerTextRef(tabId: number, ref: string): Promise<string> {
  const objectId = await resolveObject(tabId, ref);
  const r = (await send({ tabId }, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function(){ return this.innerText || this.textContent || ''; }`,
    returnByValue: true,
  })) as { result?: { value?: string } };
  return r?.result?.value ?? '';
}
