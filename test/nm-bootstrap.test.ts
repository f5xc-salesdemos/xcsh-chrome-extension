import { describe, expect, test } from 'bun:test';
import {
  contextHintTenant,
  hasNoRemainingTenantTab,
  shouldProvision,
  shouldShowContextHint,
} from '../src/nm-bootstrap';

describe('nm-bootstrap: shouldProvision', () => {
  test('true when a tenant is focused, no bridge port, and not pinned', () => {
    expect(shouldProvision('alpha|staging', undefined, false)).toBe(true);
  });

  test('false when there is no focused tenant (null session key)', () => {
    expect(shouldProvision(null, undefined, false)).toBe(false);
  });

  test('false when a bridge port already serves the tenant', () => {
    expect(shouldProvision('alpha|staging', 19222, false)).toBe(false);
  });

  test('false when the port is pinned (manual-port mode)', () => {
    expect(shouldProvision('alpha|staging', undefined, true)).toBe(false);
  });

  test('false when both a port exists and pinned', () => {
    expect(shouldProvision('alpha|staging', 19222, true)).toBe(false);
  });
});

describe('nm-bootstrap: hasNoRemainingTenantTab', () => {
  test('true when no remaining tab belongs to the closed tab tenant', () => {
    expect(hasNoRemainingTenantTab(['beta|production'], 'alpha|staging')).toBe(true);
  });

  test('true when there are no remaining tenant tabs at all', () => {
    expect(hasNoRemainingTenantTab([], 'alpha|staging')).toBe(true);
  });

  test('false when another open tab still belongs to the tenant', () => {
    expect(hasNoRemainingTenantTab(['alpha|staging'], 'alpha|staging')).toBe(false);
  });

  test('false when the tenant appears among several remaining keys', () => {
    expect(hasNoRemainingTenantTab(['beta|production', 'alpha|staging'], 'alpha|staging')).toBe(false);
  });
});

describe('nm-bootstrap: shouldShowContextHint', () => {
  test('true when a session is present but the worker is contextless', () => {
    expect(shouldShowContextHint(true, false)).toBe(true);
  });

  test('false when a session is present and the worker is context-bound', () => {
    expect(shouldShowContextHint(true, true)).toBe(false);
  });

  test('false when there is no session, regardless of contextBound', () => {
    expect(shouldShowContextHint(false, false)).toBe(false);
    expect(shouldShowContextHint(false, true)).toBe(false);
  });
});

describe('nm-bootstrap: contextHintTenant', () => {
  test('returns the active tenant when its live bridge is contextless', () => {
    expect(contextHintTenant('alpha|staging', [{ tenant: 'alpha|staging', contextBound: false }])).toBe(
      'alpha|staging',
    );
  });

  test('treats a missing contextBound as contextless (default false → hint)', () => {
    expect(contextHintTenant('alpha|staging', [{ tenant: 'alpha|staging' }])).toBe('alpha|staging');
  });

  test('null when the active tenant is context-bound', () => {
    expect(contextHintTenant('alpha|staging', [{ tenant: 'alpha|staging', contextBound: true }])).toBeNull();
  });

  test('null when the active tenant has no live bridge (disconnected)', () => {
    expect(contextHintTenant('alpha|staging', [{ tenant: 'beta|production', contextBound: false }])).toBeNull();
  });

  test('null when there is no focused tenant', () => {
    expect(contextHintTenant(null, [{ tenant: 'alpha|staging', contextBound: false }])).toBeNull();
  });

  // The exact multi-tenant bug: a background contextless worker must NOT flag the
  // focused, fully context-bound tenant. The hint is keyed off the focused tab only.
  test('a different contextless tenant does not trigger a hint for the focused bound tenant', () => {
    expect(
      contextHintTenant('alpha|staging', [
        { tenant: 'alpha|staging', contextBound: true },
        { tenant: 'beta|production', contextBound: false },
      ]),
    ).toBeNull();
  });
});
