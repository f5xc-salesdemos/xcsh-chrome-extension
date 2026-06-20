import { describe, expect, it } from "bun:test";
import { parseHTML } from "linkedom";
import { commitInputValue } from "../src/accessibility-tree";
import { serializeAx, type AxRefNode } from "../src/ax-serialize";

function flatten(tree: AxRefNode): string[] {
  const out: string[] = [];
  (function walk(n: AxRefNode) {
    out.push(`${n.role}:${n.name}:${n.ref}`);
    n.children.forEach(walk);
  })(tree);
  return out;
}

describe("serializeAx", () => {
  it("serializes roles+names with stable refs and populates the refMap", () => {
    const { document } = parseHTML(
      `<main><button>Save</button><input type="text" aria-label="Name"></main>`,
    );
    const refMap = new Map<string, WeakRef<Element>>();
    const tree = serializeAx(document.querySelector("main")!, refMap);
    const flat = flatten(tree);

    expect(flat.some((s) => s.startsWith("button:Save:ref_"))).toBe(true);
    expect(flat.some((s) => s.startsWith("textbox:Name:ref_"))).toBe(true);
    expect(refMap.size).toBeGreaterThan(0);
  });

  it("prefers an explicit role attribute over the tag heuristic", () => {
    const { document } = parseHTML(`<div role="tab">Overview</div>`);
    const refMap = new Map<string, WeakRef<Element>>();
    const tree = serializeAx(document.querySelector("div")!, refMap);
    expect(tree.role).toBe("tab");
    expect(tree.name).toBe("Overview");
  });

  it("maps common tags and prefers placeholder for names", () => {
    const { document } = parseHTML(
      `<form><input type="search" placeholder="Find"><select></select><a href="#">Docs</a></form>`,
    );
    const refMap = new Map<string, WeakRef<Element>>();
    const tree = serializeAx(document.querySelector("form")!, refMap);
    const flat = flatten(tree);
    expect(flat.some((s) => s.startsWith("textbox:Find:ref_"))).toBe(true);
    expect(flat.some((s) => s.startsWith("combobox::ref_"))).toBe(true);
    expect(flat.some((s) => s.startsWith("link:Docs:ref_"))).toBe(true);
  });

  it("skips script, style, noscript and template elements", () => {
    const { document } = parseHTML(
      `<main><script>var a=1;</script><style>.x{}</style><noscript>x</noscript><template><b>t</b></template><button>Go</button></main>`,
    );
    const refMap = new Map<string, WeakRef<Element>>();
    const tree = serializeAx(document.querySelector("main")!, refMap);
    const flat = flatten(tree);

    // Only the <main> and the <button> should be serialized.
    expect(tree.children.length).toBe(1);
    expect(flat.some((s) => s.startsWith("button:Go:ref_"))).toBe(true);
    expect(flat.length).toBe(2);
    // refMap holds exactly the serialized nodes (main + button).
    expect(refMap.size).toBe(2);
  });
});

describe("commitInputValue (ported from xcsh input-commit.ts)", () => {
  it("sets value via the prototype setter, bypassing an instance-patched descriptor", () => {
    let nativeStored = "";
    const proto = {};
    Object.defineProperty(proto, "value", {
      configurable: true,
      get() {
        return nativeStored;
      },
      set(v: string) {
        nativeStored = v;
      },
    });
    const el: any = Object.create(proto);
    let patchedCalled = false;
    Object.defineProperty(el, "value", {
      configurable: true,
      get() {
        return nativeStored;
      },
      set() {
        patchedCalled = true;
      },
    });
    const events: string[] = [];
    el.dispatchEvent = (e: any) => {
      events.push(e.type);
      return true;
    };
    el.ownerDocument = {
      defaultView: {
        Event: class {
          type: string;
          bubbles: boolean;
          constructor(t: string, o?: any) {
            this.type = t;
            this.bubbles = !!o?.bubbles;
          }
        },
      },
    };
    commitInputValue(el, "x.example.com");
    expect(nativeStored).toBe("x.example.com");
    expect(patchedCalled).toBe(false);
    expect(events).toEqual(["input", "change", "blur", "focusout"]);
  });
});
