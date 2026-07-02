/**
 * chrome.storage.local adapter for chat history. Thin I/O over the pure model in
 * references-store.ts: this file knows the key layout and Chrome APIs; it owns
 * no shaping logic.
 *
 *   xcsh.chat.index        → { conversations: string[], active: string|null }
 *   xcsh.chat.conv.<id>    → Conversation
 */

import {
  type ChatIndex,
  type Conversation,
  emptySessionIndex,
  emptyTabIndex,
  type SessionIndex,
  sessionIndexFromTabIndex,
  type TabIndex,
} from './references-store';
import { sessionKeyFromUrl, sessionKeyStr } from './tab-binding';

export const INDEX_KEY = 'xcsh.chat.index';
export function convKey(id: string): string {
  return `xcsh.chat.conv.${id}`;
}

export async function loadIndex(): Promise<ChatIndex> {
  const got = await chrome.storage.local.get(INDEX_KEY);
  const idx = got[INDEX_KEY] as ChatIndex | undefined;
  return idx && Array.isArray(idx.conversations) ? idx : { conversations: [], active: null };
}

export async function saveIndex(index: ChatIndex): Promise<void> {
  await chrome.storage.local.set({ [INDEX_KEY]: index });
}

export async function loadConversation(id: string): Promise<Conversation | null> {
  const key = convKey(id);
  const got = await chrome.storage.local.get(key);
  return (got[key] as Conversation | undefined) ?? null;
}

export async function saveConversation(conv: Conversation): Promise<void> {
  await chrome.storage.local.set({ [convKey(conv.id)]: conv });
}

export async function deleteConversations(ids: string[]): Promise<void> {
  if (ids.length) await chrome.storage.local.remove(ids.map(convKey));
}

export const TAB_INDEX_KEY = 'xcsh.chat.tabindex';

export async function loadTabIndex(): Promise<TabIndex> {
  const got = await chrome.storage.local.get(TAB_INDEX_KEY);
  const idx = got[TAB_INDEX_KEY] as TabIndex | undefined;
  return idx && typeof idx.byTab === 'object' ? idx : emptyTabIndex();
}

export async function saveTabIndex(index: TabIndex): Promise<void> {
  await chrome.storage.local.set({ [TAB_INDEX_KEY]: index });
}

// --- SessionIndex: per-tenant sessions (Phase 2) ---------------------------
export const SESSION_INDEX_KEY = 'xcsh.chat.sessionindex';

export async function loadSessionIndex(): Promise<SessionIndex> {
  const got = await chrome.storage.local.get(SESSION_INDEX_KEY);
  const idx = got[SESSION_INDEX_KEY] as SessionIndex | undefined;
  if (idx && typeof idx.byTenant === 'object' && typeof idx.byTab === 'object') return idx;
  return migrateFromTabIndex(); // one-time best-effort migration from the old per-tab index
}

export async function saveSessionIndex(index: SessionIndex): Promise<void> {
  await chrome.storage.local.set({ [SESSION_INDEX_KEY]: index });
}

/** Best-effort migration: resolve each old tab's CURRENT url → session key and
 * re-key its conversation by tenant. Tabs whose key can't be resolved (closed,
 * navigated away, non-console) are dropped; conversations are never deleted. */
async function migrateFromTabIndex(): Promise<SessionIndex> {
  const old = await loadTabIndex();
  const entries: Array<{ tabId: number; sessionKey: string; convId: string }> = [];
  for (const [tabIdStr, convId] of Object.entries(old.byTab)) {
    const tabId = Number(tabIdStr);
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    const key = sessionKeyFromUrl(tab?.url);
    if (key) entries.push({ tabId, sessionKey: sessionKeyStr(key), convId });
  }
  const migrated = entries.length ? sessionIndexFromTabIndex(entries) : emptySessionIndex();
  await saveSessionIndex(migrated);
  return migrated;
}
