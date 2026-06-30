import { describe, expect, it } from 'bun:test';
import {
  buildContextSnapshot,
  redactSecrets,
  SNAPSHOT_CAPS,
  type SnapshotInputs,
  snapshotMetadata,
} from '../src/context-snapshot';

const base = (over: Partial<SnapshotInputs> = {}): SnapshotInputs => ({
  tabId: 7,
  url: 'https://acme.console.ves.volterra.io/web/namespaces/default/http_loadbalancers/lb1',
  title: 'lb1 — Distributed Cloud',
  capturedAt: 1_000,
  ax: { role: 'WebArea', name: 'root', children: [] },
  api: {
    url: '/api/config/namespaces/default/http_loadbalancers/lb1',
    status: 200,
    resourceType: 'http_loadbalancers',
    body: { metadata: { name: 'lb1' } },
  },
  ...over,
});

describe('redactSecrets', () => {
  it('redacts denylisted keys recursively', () => {
    const out = redactSecrets({ token: 'x', nested: { password: 'p', api_key: 'k', ok: 1 } });
    expect(out).toEqual({ token: '[redacted]', nested: { password: '[redacted]', api_key: '[redacted]', ok: 1 } });
  });

  it('redacts OAuth/OIDC suffix keys', () => {
    const out = redactSecrets({
      access_token: 'at',
      refresh_token: 'rt',
      id_token: 'it',
      client_secret: 'cs',
      bearer: 'b',
      credentials: 'c',
      namespace: 'default',
    });
    expect(out).toEqual({
      access_token: '[redacted]',
      refresh_token: '[redacted]',
      id_token: '[redacted]',
      client_secret: '[redacted]',
      bearer: '[redacted]',
      credentials: '[redacted]',
      namespace: 'default',
    });
  });
});

describe('buildContextSnapshot', () => {
  it('derives path and carries api/ax through under budget', () => {
    const s = buildContextSnapshot(base());
    expect(s.v).toBe(1);
    expect(s.path).toBe('/web/namespaces/default/http_loadbalancers/lb1');
    expect(s.api?.resourceType).toBe('http_loadbalancers');
    expect(s.truncated).toBe(false);
  });

  it('redacts secrets inside the api body', () => {
    const s = buildContextSnapshot(
      base({ api: { url: '/a', status: 200, resourceType: null, body: { spec: { token: 'sekret' } } } }),
    );
    expect(((s.api?.body as Record<string, unknown>).spec as Record<string, unknown>).token).toBe('[redacted]');
  });

  it('caps a huge ax tree by node count and marks truncated', () => {
    const children = Array.from({ length: 5000 }, (_, i) => ({ role: 'button', name: `b${i}`, ref: String(i) }));
    const s = buildContextSnapshot(base({ ax: { role: 'WebArea', name: 'root', children } }));
    const count = (n: Record<string, unknown>): number =>
      1 +
      ((n.children as Array<Record<string, unknown>>) ?? []).reduce(
        (a: number, c: Record<string, unknown>) => a + count(c),
        0,
      );
    expect(count(s.ax as Record<string, unknown>)).toBeLessThanOrEqual(SNAPSHOT_CAPS.axNodes + 1);
    expect(s.truncated).toBe(true);
  });

  it('drops ax first when the whole snapshot exceeds the total budget', () => {
    const big = 'z'.repeat(SNAPSHOT_CAPS.total); // body alone blows the total
    const s = buildContextSnapshot(base({ api: { url: '/a', status: 200, resourceType: 't', body: { blob: big } } }));
    expect(JSON.stringify(s).length).toBeLessThanOrEqual(SNAPSHOT_CAPS.total);
    expect(s.truncated).toBe(true);
  });

  it('handles a malformed url without throwing', () => {
    const s = buildContextSnapshot(base({ url: 'not a url' }));
    expect(s.path).toBe('');
  });
});

describe('snapshotMetadata', () => {
  it('returns sizes and identity only', () => {
    const m = snapshotMetadata(buildContextSnapshot(base()));
    expect(m.title).toContain('lb1');
    expect(typeof m.axBytes).toBe('number');
    expect(typeof m.apiBytes).toBe('number');
  });
});

describe('sanitizeUrl (M2 security: strip query/hash from snapshot url)', () => {
  it('strips query string and hash — no access_token leaks', () => {
    const rawUrl =
      'https://x.console.ves.volterra.io/web/namespaces/default/http_loadbalancers/lb1?access_token=eyABC&state=xyz#frag';
    const s = buildContextSnapshot(
      base({
        url: rawUrl,
        title: 'test',
      }),
    );
    // url field must contain NO query or hash
    expect(s.url).toBe('https://x.console.ves.volterra.io/web/namespaces/default/http_loadbalancers/lb1');
    expect(s.url).not.toContain('access_token');
    expect(s.url).not.toContain('?');
    expect(s.url).not.toContain('#');
    // path field is already pathname-only and must remain so
    expect(s.path).toBe('/web/namespaces/default/http_loadbalancers/lb1');
  });

  it('handles a url that new URL() cannot parse — strips from first ?/#', () => {
    const s = buildContextSnapshot(base({ url: 'not-a-url?token=secret#frag' }));
    expect(s.url).not.toContain('token');
    expect(s.url).not.toContain('?');
    expect(s.url).not.toContain('#');
    expect(s.path).toBe('');
  });
});
