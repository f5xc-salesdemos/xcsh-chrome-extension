/**
 * The dispatch core — pure and chrome-free, so it's unit-testable. Given a tool
 * name, params, and a handler map, it: rejects unknown tools, validates params
 * against the published contract (`capabilities`), and only then invokes the
 * handler. The service worker supplies the real (chrome-bound) handler map.
 */

import { validateToolParams } from './capabilities';

export type ToolHandler = (params: unknown) => unknown | Promise<unknown>;

export async function runDispatch(
  tool: string,
  params: unknown,
  handlers: Record<string, ToolHandler>,
): Promise<unknown> {
  const handler = handlers[tool];
  if (!handler) throw new Error(`unknown tool: ${tool}`);
  const p = params ?? {};
  const v = validateToolParams(tool, p);
  if (!v.ok) throw new Error(v.error);
  return handler(p);
}
