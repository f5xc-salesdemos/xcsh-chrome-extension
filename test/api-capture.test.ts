import { describe, expect, it } from 'bun:test';
import {
  API_CAPTURE_CAPS,
  isJsonMime,
  isXcResourceApi,
  resourceTypeFromUrl,
  shouldFetchBody,
} from '../src/api-capture';

describe('isXcResourceApi', () => {
  it('matches a single-resource GET', () => {
    expect(
      isXcResourceApi('https://acme.console.ves.volterra.io/api/config/namespaces/default/http_loadbalancers/lb1'),
    ).toBe(true);
  });
  it('rejects a list endpoint (no resource name)', () => {
    expect(
      isXcResourceApi('https://acme.console.ves.volterra.io/api/config/namespaces/default/http_loadbalancers'),
    ).toBe(false);
  });
  it('rejects non-config paths and non-urls', () => {
    expect(isXcResourceApi('https://acme.console.ves.volterra.io/api/data/namespaces/default/metrics/foo')).toBe(false);
    expect(isXcResourceApi('nonsense')).toBe(false);
  });
});

describe('resourceTypeFromUrl', () => {
  it('extracts the type segment', () => {
    expect(resourceTypeFromUrl('https://x/api/config/namespaces/default/http_loadbalancers/lb1')).toBe(
      'http_loadbalancers',
    );
  });
  it('returns null when not a resource url', () => {
    expect(resourceTypeFromUrl('https://x/web/foo')).toBeNull();
  });
});

describe('shouldFetchBody', () => {
  it('fetches small JSON', () => {
    expect(shouldFetchBody('application/json', 1024)).toBe(true);
  });
  it('skips non-JSON or oversize', () => {
    expect(shouldFetchBody('text/html', 10)).toBe(false);
    expect(shouldFetchBody('application/json', API_CAPTURE_CAPS.maxEncodedBytes + 1)).toBe(false);
  });
  it('isJsonMime tolerates charset suffix', () => {
    expect(isJsonMime('application/json; charset=utf-8')).toBe(true);
  });
  it('rejects negative encodedDataLength (CDP error sentinel)', () => {
    expect(shouldFetchBody('application/json', -1)).toBe(false);
  });
  it('rejects undefined mime', () => {
    expect(shouldFetchBody(undefined, 1024)).toBe(false);
  });
});
