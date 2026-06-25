import { type AxRefNode, serializeAx } from './ax-serialize';

const REFMAP = new Map<string, WeakRef<Element>>();

// biome-ignore lint/suspicious/noExplicitAny: Chrome extension API typings
(globalThis as any).__xcshReadAx = (): AxRefNode => {
  REFMAP.clear(); // rebuild each call
  return serializeAx(document.documentElement, REFMAP);
};

// biome-ignore lint/suspicious/noExplicitAny: Chrome extension API typings
(globalThis as any).__xcshResolveRef = (ref: string): { x: number; y: number } | null => {
  const el = REFMAP.get(ref)?.deref();
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};

// Return the live Element for a ref (not coords) so the deterministic click path
// can take an object handle and derive geometry from the renderer (getContentQuads).
// biome-ignore lint/suspicious/noExplicitAny: Chrome extension API typings
(globalThis as any).__xcshResolveRefEl = (ref: string): Element | null => REFMAP.get(ref)?.deref() ?? null;

/** Port of xcsh input-commit.ts commitInputValue — bypasses framework-patched value descriptors. */
// biome-ignore lint/suspicious/noExplicitAny: Chrome extension API typings
export function commitInputValue(el: any, value: string): void {
  let descriptor: PropertyDescriptor | undefined;
  let proto: object | null = Object.getPrototypeOf(el);
  while (proto) {
    descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor) break;
    proto = Object.getPrototypeOf(proto);
  }
  if (descriptor?.set) descriptor.set.call(el, value);
  else el.value = value;
  const view = el.ownerDocument?.defaultView;
  const Ev = view?.Event ?? (typeof Event !== 'undefined' ? Event : undefined);
  if (Ev) {
    el.dispatchEvent(new Ev('input', { bubbles: true }));
    el.dispatchEvent(new Ev('change', { bubbles: true }));
    el.dispatchEvent(new Ev('blur', { bubbles: false }));
    el.dispatchEvent(new Ev('focusout', { bubbles: true }));
  }
}

// biome-ignore lint/suspicious/noExplicitAny: Chrome extension API typings
(globalThis as any).__xcshCommitInputValue = (ref: string, value: string): void => {
  const el = REFMAP.get(ref)?.deref();
  if (!el) throw new Error(`ref ${ref} not found`);
  (el as HTMLInputElement).focus?.();
  commitInputValue(el, value);
};

// biome-ignore lint/suspicious/noExplicitAny: Chrome extension API typings
(globalThis as any).__xcshSelectOption = (ref: string, value: string): boolean => {
  const el = REFMAP.get(ref)?.deref() as HTMLSelectElement | null;
  if (!el) throw new Error(`ref ${ref} not found`);
  const opt = Array.from(el.options).find((o) => o.value === value || o.text === value);
  if (!opt) return false;
  el.value = opt.value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
};

// biome-ignore lint/suspicious/noExplicitAny: Chrome extension API typings
(globalThis as any).__xcshScrollTo = (ref: string): void => {
  const el = REFMAP.get(ref)?.deref();
  if (!el) throw new Error(`ref ${ref} not found`);
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
};

// biome-ignore lint/suspicious/noExplicitAny: Chrome extension API typings
(globalThis as any).__xcshGetPageText = (): string => {
  return (document.body?.innerText ?? '').slice(0, 50_000);
};

// biome-ignore lint/suspicious/noExplicitAny: Chrome extension API typings
(globalThis as any).__xcshGetInnerText = (ref: string): string => {
  const el = REFMAP.get(ref)?.deref();
  if (!el) throw new Error(`ref ${ref} not found`);
  return (el as HTMLElement).innerText ?? '';
};
