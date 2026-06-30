/**
 * XC API response classification — PURE decisions for the SW's passive CDP
 * Network capture. Keeps "is this a resource we want, and is it worth fetching"
 * out of the chrome-bound listener so it is unit-testable.
 *
 * XC config resources look like:
 *   /api/config/namespaces/<ns>/<type>/<name>
 * A single-resource GET has a trailing <name>; a list ends at <type>.
 */

export const API_CAPTURE_CAPS = { maxEncodedBytes: 256 * 1024 } as const;

const RESOURCE_RE = /\/api\/config\/namespaces\/[^/]+\/([a-z0-9_]+)\/[^/?#]+/i;

function pathname(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

export function isXcResourceApi(url: string): boolean {
  const p = pathname(url);
  return p !== null && RESOURCE_RE.test(p);
}

export function resourceTypeFromUrl(url: string): string | null {
  const p = pathname(url);
  const m = p ? RESOURCE_RE.exec(p) : null;
  return m ? m[1] : null;
}

export function isJsonMime(mimeType: string | undefined): boolean {
  return typeof mimeType === 'string' && /\bjson\b/i.test(mimeType);
}

export function shouldFetchBody(
  mimeType: string | undefined,
  encodedDataLength: number,
  caps: typeof API_CAPTURE_CAPS = API_CAPTURE_CAPS,
): boolean {
  return isJsonMime(mimeType) && encodedDataLength >= 0 && encodedDataLength < caps.maxEncodedBytes;
}
