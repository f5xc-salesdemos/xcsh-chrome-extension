import { describe, expect, it } from 'bun:test';
import {
  buildChatRequest,
  buildChatStop,
  type ChatStreamMsg,
  initChatTurn,
  isChatInbound,
  reduceChatTurn,
} from '../src/chat-protocol';

describe('buildChatRequest', () => {
  it('shapes a chat_request with passthrough context and mode', () => {
    const m = buildChatRequest('c-1', 'hi', { url: 'x' }, 'educational', 'conv-1');
    expect(m).toEqual({
      type: 'chat_request',
      id: 'c-1',
      text: 'hi',
      context: { url: 'x' },
      mode: 'educational',
      history_hint: 'conv-1',
    });
  });
  it('omits history_hint when not given', () => {
    const m = buildChatRequest('c-1', 'hi', null, 'presentation');
    expect('history_hint' in m).toBe(false);
    expect(m.mode).toBe('presentation');
  });
});

describe('buildChatStop', () => {
  it('shapes a chat_stop message', () => {
    const m = buildChatStop('c-1');
    expect(m).toEqual({ type: 'chat_stop', id: 'c-1' });
  });
});

describe('reduceChatTurn', () => {
  const feed = (msgs: ChatStreamMsg[]) => msgs.reduce(reduceChatTurn, initChatTurn('c-1'));

  it('accumulates ordered deltas', () => {
    const s = feed([
      { type: 'chat_delta', id: 'c-1', seq: 0, delta: 'Hel' },
      { type: 'chat_delta', id: 'c-1', seq: 1, delta: 'lo' },
    ]);
    expect(s.text).toBe('Hello');
    expect(s.status).toBe('streaming');
  });

  it('ignores duplicate/older seq', () => {
    const s = feed([
      { type: 'chat_delta', id: 'c-1', seq: 0, delta: 'A' },
      { type: 'chat_delta', id: 'c-1', seq: 0, delta: 'A' },
      { type: 'chat_delta', id: 'c-1', seq: 1, delta: 'B' },
    ]);
    expect(s.text).toBe('AB');
  });

  it('finalizes on done with references', () => {
    const s = feed([
      { type: 'chat_delta', id: 'c-1', seq: 0, delta: 'x' },
      { type: 'chat_done', id: 'c-1', references: [{ kind: 'doc', title: 'T', url: 'https://d' }] },
    ]);
    expect(s.status).toBe('done');
    expect(s.references).toHaveLength(1);
  });

  it('records errors and ignores events after a terminal state', () => {
    const s = feed([
      { type: 'chat_error', id: 'c-1', error: 'boom' },
      { type: 'chat_delta', id: 'c-1', seq: 0, delta: 'late' },
    ]);
    expect(s.status).toBe('error');
    expect(s.error).toBe('boom');
    expect(s.text).toBe('');
  });

  it('ignores chat_delta with mismatched id', () => {
    const s = feed([
      { type: 'chat_delta', id: 'c-1', seq: 0, delta: 'Hel' },
      { type: 'chat_delta', id: 'c-2', seq: 1, delta: 'lo' }, // wrong id
    ]);
    expect(s.text).toBe('Hel');
  });

  it('chat_done without references yields empty array', () => {
    const s = feed([
      { type: 'chat_delta', id: 'c-1', seq: 0, delta: 'x' },
      { type: 'chat_done', id: 'c-1' }, // no references
    ]);
    expect(s.status).toBe('done');
    expect(s.references).toEqual([]);
  });
});

describe('isChatInbound', () => {
  it('accepts chat_delta, chat_done, chat_error, and chat_tool_notice', () => {
    expect(isChatInbound({ type: 'chat_delta', id: 'c', seq: 0, delta: '' })).toBe(true);
    expect(isChatInbound({ type: 'chat_done', id: 'c' })).toBe(true);
    expect(isChatInbound({ type: 'chat_error', id: 'c', error: 'x' })).toBe(true);
    expect(isChatInbound({ type: 'chat_tool_notice', id: 'c', tool: 'grep', ok: true })).toBe(true);
    expect(isChatInbound({ type: 'tool_result', id: '1' })).toBe(false);
    expect(isChatInbound(null)).toBe(false);
  });
});
