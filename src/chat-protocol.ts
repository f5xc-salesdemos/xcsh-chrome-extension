/**
 * Chat-turn protocol — the reverse (user → xcsh) channel that complements the
 * existing tool_request/tool_result flow. PURE and chrome-free: the SW and the
 * side panel both import it, and the streaming reducer is deterministically
 * unit-tested (mirroring the pure-core split in overlays.ts / dispatch.ts).
 *
 * Chat ids are prefixed `c-` so they never collide with tool-request ids — the
 * SW routes by that disjoint id space.
 */

export type InteractionMode = 'educational' | 'presentation' | 'configuration' | 'screenshot' | 'annotation';
export const DEFAULT_MODE: InteractionMode = 'educational';
export const INTERACTION_MODES: readonly { id: InteractionMode; label: string; blurb: string }[] = [
  {
    id: 'educational',
    label: 'Educational',
    blurb: 'Explain concepts and answer questions about settings and their purpose.',
  },
  { id: 'presentation', label: 'Presentation', blurb: 'Guided, human-paced walkthrough/demo of the console.' },
  { id: 'configuration', label: 'Config building', blurb: 'Help build and fill F5 XC resource configuration.' },
  { id: 'screenshot', label: 'Screenshot', blurb: 'Capture annotated screenshots for documentation.' },
  { id: 'annotation', label: 'Annotation', blurb: 'Annotate the page for documentation and teaching.' },
];

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
  mode: InteractionMode;
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
export type ChatStreamMsg = ChatDeltaMsg | ChatDoneMsg | ChatErrorMsg;

export interface ChatStopMsg {
  type: 'chat_stop';
  id: string;
}
export interface ChatToolNoticeMsg {
  type: 'chat_tool_notice';
  id: string;
  tool: string;
  ok: boolean;
  detail?: string;
}

export type ChatInbound = ChatStreamMsg | ChatToolNoticeMsg;

export interface ChatTurnState {
  id: string;
  text: string;
  status: 'streaming' | 'done' | 'error';
  references: ChatRefWire[];
  error?: string;
  lastSeq: number;
}

/** Shape a chat_request for the bridge. The caller owns id generation. */
export function buildChatRequest(
  id: string,
  text: string,
  context: unknown,
  mode: InteractionMode,
  historyHint?: string,
): ChatRequestMsg {
  const msg: ChatRequestMsg = { type: 'chat_request', id, text, context, mode };
  if (historyHint !== undefined) msg.history_hint = historyHint;
  return msg;
}

/** Shape a chat_stop message to request cancellation. */
export function buildChatStop(id: string): ChatStopMsg {
  return { type: 'chat_stop', id };
}

export function initChatTurn(id: string): ChatTurnState {
  return { id, text: '', status: 'streaming', references: [], lastSeq: -1 };
}

/** Fold one inbound stream event into the turn state. Idempotent after terminal. */
export function reduceChatTurn(state: ChatTurnState, msg: ChatStreamMsg): ChatTurnState {
  if (msg.id !== state.id) return state; // not this turn — ignore
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
  return t === 'chat_delta' || t === 'chat_done' || t === 'chat_error' || t === 'chat_tool_notice';
}
