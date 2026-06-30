import { describe, expect, it } from 'bun:test';
import { parseHTML } from 'linkedom';
import { type OverlaySpec, planOverlay, showOverlay } from '../src/overlays';

describe('planOverlay', () => {
  it('returns null for an unknown kind', () => {
    expect(planOverlay({ kind: 'nope' } as OverlaySpec)).toBeNull();
    expect(planOverlay({} as OverlaySpec)).toBeNull();
  });

  describe('fingerprint', () => {
    it('requires finite x and y', () => {
      expect(planOverlay({ kind: 'fingerprint' })).toBeNull();
      expect(planOverlay({ kind: 'fingerprint', x: 10 })).toBeNull();
      expect(planOverlay({ kind: 'fingerprint', x: 10, y: Number.NaN })).toBeNull();
    });

    it('positions the host at the click point and animates the ring + svg', () => {
      const plan = planOverlay({ kind: 'fingerprint', x: 100, y: 200 });
      expect(plan).not.toBeNull();
      if (!plan) return;
      expect(plan.left).toBe(100);
      expect(plan.top).toBe(200);
      expect(plan.html).toContain('class="ring"');
      expect(plan.html).toContain('<svg');
      expect(plan.anims.map((a) => a.sel).sort()).toEqual(['.ring', 'svg']);
      // ttl must outlast the longest animation so the node never leaks.
      const longest = Math.max(...plan.anims.map((a) => a.timing.duration));
      expect(plan.ttlMs).toBeGreaterThanOrEqual(longest);
    });
  });

  describe('highlight', () => {
    it('requires finite, positive geometry', () => {
      expect(planOverlay({ kind: 'highlight', x: 1, y: 1 })).toBeNull();
      expect(planOverlay({ kind: 'highlight', x: 1, y: 1, w: 0, h: 10 })).toBeNull();
      expect(planOverlay({ kind: 'highlight', x: 1, y: 1, w: 10, h: -5 })).toBeNull();
    });

    it('insets the host by the pad and grows the box by 2*pad', () => {
      const plan = planOverlay({ kind: 'highlight', x: 50, y: 60, w: 200, h: 40 });
      expect(plan).not.toBeNull();
      if (!plan) return;
      // host is inset by HIGHLIGHT_PAD (4) so the outline surrounds the target.
      expect(plan.left).toBe(46);
      expect(plan.top).toBe(56);
      expect(plan.html).toContain('width:208px'); // 200 + 2*4
      expect(plan.html).toContain('height:48px'); // 40 + 2*4
      expect(plan.anims).toHaveLength(1);
      expect(plan.anims[0].sel).toBe('.box');
      expect(plan.ttlMs).toBeGreaterThanOrEqual(plan.anims[0].timing.duration);
    });
  });

  describe('callout', () => {
    it('requires finite position and a non-empty text', () => {
      expect(planOverlay({ kind: 'callout', x: 1, y: 1 })).toBeNull(); // no text
      expect(planOverlay({ kind: 'callout', text: 'hello' })).toBeNull(); // no position
      expect(planOverlay({ kind: 'callout', x: 1, y: 1, text: '' })).toBeNull(); // empty text
    });

    it('positions the host at the target and includes the text in the markup', () => {
      const plan = planOverlay({ kind: 'callout', x: 200, y: 100, text: 'Click the Add button' });
      expect(plan).not.toBeNull();
      if (!plan) return;
      expect(plan.left).toBe(200);
      expect(plan.top).toBeLessThanOrEqual(100); // above/at the target
      expect(plan.html).toContain('Click the Add button');
      expect(plan.anims.length).toBeGreaterThan(0);
      expect(plan.ttlMs).toBeGreaterThanOrEqual(plan.anims[0].timing.duration);
    });
  });
});

describe('showOverlay (DOM integration)', () => {
  it('creates a host element with a shadow root and cleans up after ttlMs', async () => {
    // linkedom doesn't support element.animate, so showOverlay falls back to the
    // setTimeout cleanup path. We verify the host is created + removed.
    const { document } = parseHTML('<!doctype html><html><head></head><body></body></html>');
    const origDoc = globalThis.document;
    // Temporarily patch the global document so showOverlay's createElement works.
    (globalThis as unknown as { document: typeof document }).document = document as unknown as Document;
    try {
      showOverlay({ kind: 'fingerprint', x: 100, y: 200 });
      // Host should be appended to documentElement.
      const hosts = document.documentElement.querySelectorAll('div');
      expect(hosts.length).toBeGreaterThanOrEqual(1);
      const host = hosts[hosts.length - 1];
      if (!host) throw new Error('expected an overlay host to be appended');
      expect(host.style.cssText).toContain('position:fixed');
      expect(host.style.cssText).toContain('left:100px');
      expect(host.shadowRoot).not.toBeNull();
      // Wait for the ttl cleanup (~950ms for fingerprint).
      await new Promise((r) => setTimeout(r, 1100));
      // The host should have been removed (parentNode null).
      expect(host.parentNode).toBeNull();
    } finally {
      (globalThis as unknown as { document: typeof document }).document = origDoc as unknown as typeof document;
    }
  });
});
