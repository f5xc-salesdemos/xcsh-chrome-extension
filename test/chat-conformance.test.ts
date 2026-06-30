import { describe, expect, it } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import committed from '../chat-conformance.json';
import { renderConformance } from '../scripts/gen-conformance';
import { INTERACTION_MODES, initChatTurn, reduceChatTurn } from '../src/chat-protocol';
import { CHAT_EXAMPLES, CHAT_SCHEMAS, PageContextSnapshotSchema } from '../src/chat-schema';

const schemaFor = (name: string) => (name === 'page_context_snapshot' ? PageContextSnapshotSchema : CHAT_SCHEMAS[name]);

describe('chat conformance — schemas + golden examples', () => {
  it('accepts every valid example against its schema (snapshot by name, messages by type)', () => {
    for (const [name, example] of Object.entries(CHAT_EXAMPLES.valid)) {
      const schemaName = name === 'page_context_snapshot' ? name : (example as { type: string }).type;
      const schema = schemaFor(schemaName);
      expect(schema, `no schema for ${schemaName}`).toBeDefined();
      expect(Value.Check(schema, example), `valid example "${name}" should pass ${schemaName}`).toBe(true);
    }
  });

  it('rejects every invalid example against its target schema', () => {
    for (const c of CHAT_EXAMPLES.invalid) {
      expect(Value.Check(schemaFor(c.schema), c.value), `invalid (${c.why}) should fail ${c.schema}`).toBe(false);
    }
  });

  it('all chat message ids use the c- prefix', () => {
    for (const [name, example] of Object.entries(CHAT_EXAMPLES.valid)) {
      if (name === 'page_context_snapshot') continue;
      expect((example as { id: string }).id.startsWith('c-')).toBe(true);
    }
  });

  it('chat_request mode is one of the published interaction modes', () => {
    const ids = new Set(INTERACTION_MODES.map((m) => m.id));
    expect(ids.has(CHAT_EXAMPLES.valid.chat_request.mode)).toBe(true);
    expect(ids.has(CHAT_EXAMPLES.valid.chat_request_no_context.mode)).toBe(true);
  });

  it('the delta/done stream folds through the reducer to a coherent terminal', () => {
    const stream = [CHAT_EXAMPLES.valid.chat_delta, CHAT_EXAMPLES.valid.chat_delta_1, CHAT_EXAMPLES.valid.chat_done];
    const final = stream.reduce(reduceChatTurn, initChatTurn('c-1111'));
    expect(final.status).toBe('done');
    expect(final.text).toBe('This LB routes traffic.');
    expect(final.references).toHaveLength(1);
  });

  it('committed chat-conformance.json is in sync with the source (run gen-conformance to refresh)', () => {
    expect(JSON.parse(renderConformance())).toEqual(committed);
  });
});
