/**
 * Chat-turn protocol — the reverse (user → xcsh) channel that complements the
 * existing tool_request/tool_result flow. PURE and chrome-free: the SW and the
 * side panel both import it, and the streaming reducer is deterministically
 * unit-tested (mirroring the pure-core split in overlays.ts / dispatch.ts).
 *
 * Chat ids are prefixed `c-` so they never collide with tool-request ids — the
 * SW routes by that disjoint id space.
 */

export interface ChatRefWire {
  kind: string; // 'doc' | 'console' | …
  title: string;
  url: string;
}

export interface ChatRequestMsg {
  type: 'chat_request';
  id: string;
  text: string;
  context: unknown; // a PageContextSnapshot, passed through opaquely
  history_hint?: string;
}

export interface ChatDeltaMsg {
  type: 'chat_delta';
  id: string;
  seq: number;
  delta: string;
}
export interface ChatDoneMsg {
  type: 'chat_done';
  id: string;
  references?: ChatRefWire[];
}
export interface ChatErrorMsg {
  type: 'chat_error';
  id: string;
  error: string;
}
export type ChatInbound = ChatDeltaMsg | ChatDoneMsg | ChatErrorMsg;

export interface ChatTurnState {
  id: string;
  text: string;
  status: 'streaming' | 'done' | 'error';
  references: ChatRefWire[];
  error?: string;
  lastSeq: number;
}

/** Shape a chat_request for the bridge. The caller owns id generation. */
export function buildChatRequest(id: string, text: string, context: unknown, historyHint?: string): ChatRequestMsg {
  const msg: ChatRequestMsg = { type: 'chat_request', id, text, context };
  if (historyHint !== undefined) msg.history_hint = historyHint;
  return msg;
}

export function initChatTurn(id: string): ChatTurnState {
  return { id, text: '', status: 'streaming', references: [], lastSeq: -1 };
}

/** Fold one inbound chat event into the turn state. Idempotent after terminal. */
export function reduceChatTurn(state: ChatTurnState, msg: ChatInbound): ChatTurnState {
  if (state.status !== 'streaming') return state; // terminal: ignore stragglers
  if (msg.type === 'chat_delta') {
    if (msg.seq <= state.lastSeq) return state; // duplicate / out-of-order
    return { ...state, text: state.text + msg.delta, lastSeq: msg.seq };
  }
  if (msg.type === 'chat_done') {
    return { ...state, status: 'done', references: msg.references ?? [] };
  }
  return { ...state, status: 'error', error: msg.error };
}

export function isChatInbound(msg: unknown): msg is ChatInbound {
  if (!msg || typeof msg !== 'object') return false;
  const t = (msg as { type?: unknown }).type;
  return t === 'chat_delta' || t === 'chat_done' || t === 'chat_error';
}
