import { describe, expect, it } from 'bun:test';
import { runDispatch, type ToolHandler } from '../src/dispatch';

describe('runDispatch', () => {
  it('throws for a tool with no handler', async () => {
    await expect(runDispatch('nope', {}, {})).rejects.toThrow('unknown tool: nope');
  });

  it('validates params before calling the handler (and does not call it on bad input)', async () => {
    let called = false;
    const handlers: Record<string, ToolHandler> = {
      click: () => {
        called = true;
        return 'ok';
      },
    };
    await expect(runDispatch('click', {}, handlers)).rejects.toThrow('click'); // ref required
    expect(called).toBe(false);
  });

  it('calls the handler with the params when valid and returns its result', async () => {
    const handlers: Record<string, ToolHandler> = {
      click: (p) => `clicked ${(p as { ref: string }).ref}`,
    };
    expect(await runDispatch('click', { ref: 'e7' }, handlers)).toBe('clicked e7');
  });

  it('treats missing params as {} for an empty-schema tool', async () => {
    const handlers: Record<string, ToolHandler> = { ping: () => ({ ok: true }) };
    expect(await runDispatch('ping', undefined, handlers)).toEqual({ ok: true });
  });
});
