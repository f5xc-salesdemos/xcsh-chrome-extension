/**
 * Conversation + reference model — PURE data ops over the chat history that the
 * side panel persists to chrome.storage.local. The storage adapter
 * (side-panel-store.ts) holds the chrome I/O; all shaping lives here so it is
 * unit-testable. References are deduped by url and stamped with the message they
 * first appeared in, for the persistent per-conversation "References" drawer.
 */

import type { ChatRefWire, InteractionMode } from './chat-protocol';
import { DEFAULT_MODE } from './chat-protocol';

export interface ChatReference {
  id: string;
  kind: string;
  title: string;
  url: string;
  firstSeenMsg: string;
}

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  at: number;
  context?: unknown;
  refs?: string[];
  tool?: string;
  ok?: boolean;
  aborted?: boolean;
}

export interface Conversation {
  id: string;
  createdAt: number;
  updatedAt: number;
  title: string;
  mode: InteractionMode;
  messages: StoredMessage[];
  references: ChatReference[];
}

export interface ChatIndex {
  conversations: string[];
  active: string | null;
}

export const CONV_CAP = 50;

export function deriveTitle(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length <= 60 ? t : `${t.slice(0, 57)}…`;
}

export function newConversation(id: string, at: number, mode: InteractionMode = DEFAULT_MODE): Conversation {
  return {
    id,
    createdAt: at,
    updatedAt: at,
    title: 'New chat',
    mode,
    messages: [],
    references: [],
  };
}

export function appendUserMessage(conv: Conversation, msg: StoredMessage): Conversation {
  const firstUser = !conv.messages.some((m) => m.role === 'user');
  return {
    ...conv,
    title: firstUser ? deriveTitle(msg.text) : conv.title,
    messages: [...conv.messages, msg],
    updatedAt: msg.at,
  };
}

export function startAssistant(conv: Conversation, msgId: string, at: number): Conversation {
  return {
    ...conv,
    messages: [...conv.messages, { id: msgId, role: 'assistant', text: '', at }],
    updatedAt: at,
  };
}

export function appendAssistantDelta(conv: Conversation, msgId: string, delta: string): Conversation {
  return {
    ...conv,
    messages: conv.messages.map((m) => (m.id === msgId ? { ...m, text: m.text + delta } : m)),
  };
}

export function finalizeAssistant(
  conv: Conversation,
  msgId: string,
  wireRefs: ChatRefWire[],
  at: number,
): Conversation {
  const byUrl = new Map(conv.references.map((r) => [r.url, r]));
  const msgRefIds: string[] = [];
  let n = conv.references.length;
  for (const w of wireRefs) {
    let ref = byUrl.get(w.url);
    if (!ref) {
      ref = { id: `${msgId}-r${n++}`, kind: w.kind, title: w.title, url: w.url, firstSeenMsg: msgId };
      byUrl.set(w.url, ref);
    }
    if (!msgRefIds.includes(ref.id)) msgRefIds.push(ref.id);
  }
  return {
    ...conv,
    updatedAt: at,
    references: [...byUrl.values()],
    messages: conv.messages.map((m) => (m.id === msgId ? { ...m, refs: msgRefIds } : m)),
  };
}

export function addToIndex(index: ChatIndex, convId: string): ChatIndex {
  const conversations = index.conversations.includes(convId) ? index.conversations : [...index.conversations, convId];
  return { conversations, active: convId };
}

export function pruneConversations(index: ChatIndex, cap = CONV_CAP): { index: ChatIndex; removed: string[] } {
  if (index.conversations.length <= cap) return { index, removed: [] };
  const removed = index.conversations.slice(0, index.conversations.length - cap);
  const conversations = index.conversations.slice(removed.length);
  const active = index.active && removed.includes(index.active) ? (conversations.at(-1) ?? null) : index.active;
  return { index: { conversations, active }, removed };
}

export function setMode(conv: Conversation, mode: InteractionMode, at: number): Conversation {
  return {
    ...conv,
    mode,
    updatedAt: at,
  };
}

export function appendToolNotice(
  conv: Conversation,
  e: { id: string; tool: string; ok: boolean; detail?: string; at: number },
): Conversation {
  const text = e.detail ?? `${e.tool}: ${e.ok ? 'ok' : 'failed'}`;
  return {
    ...conv,
    messages: [...conv.messages, { id: e.id, role: 'tool', text, at: e.at, tool: e.tool, ok: e.ok }],
    updatedAt: e.at,
  };
}

export function markAborted(conv: Conversation, msgId: string, at: number): Conversation {
  return {
    ...conv,
    messages: conv.messages.map((m) => (m.id === msgId ? { ...m, aborted: true } : m)),
    updatedAt: at,
  };
}

/** Map of live tab id → conversation id, for per-tab chat sessions. */
export interface TabIndex {
  byTab: Record<string, string>;
}

export function emptyTabIndex(): TabIndex {
  return { byTab: {} };
}

export function setTabConv(index: TabIndex, tabId: number, convId: string): TabIndex {
  return { byTab: { ...index.byTab, [String(tabId)]: convId } };
}

export function tabConv(index: TabIndex, tabId: number): string | undefined {
  return index.byTab[String(tabId)];
}

export function removeTab(index: TabIndex, tabId: number): { index: TabIndex; removedConv: string | undefined } {
  const key = String(tabId);
  const removedConv = index.byTab[key];
  if (removedConv === undefined) return { index, removedConv: undefined };
  const byTab = { ...index.byTab };
  delete byTab[key];
  return { index: { byTab }, removedConv };
}
