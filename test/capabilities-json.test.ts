import { describe, expect, it } from 'bun:test';
import cap from '../capabilities.json';
import { buildCapabilities } from '../src/capabilities';

describe('capabilities.json', () => {
  it('is in sync with the descriptor (run `bun scripts/gen-capabilities.ts` to refresh)', () => {
    // Compare against a rebuild using the file's own version, so only a real
    // tool/feature/contract drift fails this — not a version bump.
    const fresh = JSON.parse(JSON.stringify(buildCapabilities((cap as { version: string }).version)));
    expect(cap).toEqual(fresh);
  });
});
