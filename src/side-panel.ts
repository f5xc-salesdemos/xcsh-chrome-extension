/**
 * Side panel controller — the chat UI. Owns only DOM + Port I/O; all shaping is
 * delegated to the pure modules (chat-protocol, references-store, markdown-render)
 * and persistence to side-panel-store. One long-lived Port ("xcsh-chat") to the
 * SW carries chat_request out and streamed chat_delta/done/error back.
 */

import {
  buildChatRequest,
  buildChatStop,
  type ChatInbound,
  type ChatStreamMsg,
  type ChatToolNoticeMsg,
  INTERACTION_MODES,
  type InteractionMode,
  initChatTurn,
  isChatInbound,
  reduceChatTurn,
} from './chat-protocol';
import { renderMarkdown, renderReferenceChip } from './markdown-render';
import {
  appendAssistantDelta,
  appendToolNotice,
  appendUserMessage,
  type Conversation,
  finalizeAssistant,
  markAborted,
  newConversation,
  removeTab,
  setMode,
  setTabConv,
  startAssistant,
  tabConv,
} from './references-store';
import {
  deleteConversations,
  loadConversation,
  loadTabIndex,
  saveConversation,
  saveTabIndex,
} from './side-panel-store';

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const connEl = $('conn');
const modeEl = $<HTMLSelectElement>('mode');
const ctxChipEl = $('ctx-chip');
const messagesEl = $('messages');
const refsListEl = $('refs-list');
const inputEl = $<HTMLTextAreaElement>('input');
const sendBtn = $<HTMLButtonElement>('send');
const stopBtn = $<HTMLButtonElement>('stop');

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let conv: Conversation;
let latestContext: unknown = null;
let contextMeta: { title?: string; path?: string } | null = null;
let attachContext = true;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let boundTabId: number | undefined;
let isConnected = false;

const TURN_TIMEOUT_MS = 30_000;

interface ActiveTurn {
  id: string;
  msgId: string;
  state: ReturnType<typeof initChatTurn>;
  timeout?: ReturnType<typeof setTimeout>;
}
let active: ActiveTurn | null = null;

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

const port = chrome.runtime.connect({ name: 'xcsh-chat' });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveConversation(conv).catch(() => {});
  }, 300);
}

function setConnected(on: boolean): void {
  isConnected = on;
  connEl.classList.toggle('on', on);
  let banner = document.getElementById('conn-banner');
  if (!on) {
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'conn-banner';
      banner.className = 'conn-banner';
      banner.textContent = 'xcsh not connected — start the xcsh CLI to continue.';
      messagesEl.parentElement?.insertBefore(banner, messagesEl);
    }
  } else if (banner) {
    banner.remove();
  }
}

function showInactive(): void {
  conv = newConversation(`conv-${crypto.randomUUID()}`, Date.now());
  renderAll();
}

function renderContextChip(): void {
  if (attachContext && contextMeta) {
    ctxChipEl.textContent = contextMeta.title ?? contextMeta.path ?? 'current page';
  } else {
    ctxChipEl.textContent = attachContext ? 'no page attached' : 'context off';
  }
}

// ---------------------------------------------------------------------------
// Message node construction (DRY factory)
// ---------------------------------------------------------------------------

function makeAssistantNode(msgId: string, text: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  wrap.dataset.mid = msgId;

  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = 'xcsh';

  const body = document.createElement('div');
  body.className = 'body';
  body.innerHTML = renderMarkdown(text);

  const copyBtn = document.createElement('button');
  copyBtn.className = 'copy-btn';
  copyBtn.textContent = 'copy';
  copyBtn.type = 'button';
  copyBtn.addEventListener('click', () => {
    const raw = conv.messages.find((m) => m.id === msgId)?.text ?? text;
    navigator.clipboard.writeText(raw).catch(() => {});
  });

  wrap.append(who, body, copyBtn);
  return wrap;
}

function makeUserNode(msgId: string, text: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'msg user';
  wrap.dataset.mid = msgId;

  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = 'you';

  const body = document.createElement('div');
  body.className = 'body';
  body.textContent = text; // never innerHTML — XSS-safe

  wrap.append(who, body);
  return wrap;
}

function makeToolNode(msgId: string, tool: string, ok: boolean, text: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'msg tool';
  wrap.dataset.mid = msgId;

  const label = document.createElement('span');
  label.textContent = `${tool}: ${ok ? '✓' : '✗'} ${text}`;

  wrap.appendChild(label);
  return wrap;
}

function makeErrorNode(errorText: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'msg error';

  // preserve "HTTP <n> …" prefix if present
  const body = document.createElement('div');
  body.className = 'body';
  body.textContent = errorText;

  wrap.appendChild(body);
  return wrap;
}

/** Append an error block to the messages list (no data-mid). */
function renderErrorBlock(errorText: string): void {
  messagesEl.appendChild(makeErrorNode(errorText));
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

/** Replace an existing assistant node (by msgId) with a timeout/error block. */
function renderErrorBlockFor(msgId: string, errorText: string): void {
  const existingNode = messagesEl.querySelector(`[data-mid="${msgId}"]`);
  if (existingNode) existingNode.remove();
  renderErrorBlock(errorText);
}

function appendRefChips(wrap: HTMLElement, refIds: string[]): void {
  if (!refIds.length) return;
  const chips = document.createElement('div');
  chips.className = 'ref-chips';
  for (const rid of refIds) {
    const ref = conv.references.find((r) => r.id === rid);
    if (ref) chips.insertAdjacentHTML('beforeend', renderReferenceChip(ref));
  }
  wrap.appendChild(chips);
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderAll(): void {
  messagesEl.replaceChildren();
  for (const m of conv.messages) {
    let node: HTMLElement;
    if (m.role === 'user') {
      node = makeUserNode(m.id, m.text);
    } else if (m.role === 'tool') {
      node = makeToolNode(m.id, m.tool ?? 'tool', m.ok ?? true, m.text);
    } else {
      node = makeAssistantNode(m.id, m.text);
      if (m.refs?.length) appendRefChips(node, m.refs);
    }
    messagesEl.appendChild(node);
  }
  renderRefs();
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderRefs(): void {
  refsListEl.replaceChildren();
  for (const r of conv.references) refsListEl.insertAdjacentHTML('beforeend', renderReferenceChip(r));
}

function updateAssistantBody(msgId: string, text: string): void {
  const node = messagesEl.querySelector<HTMLElement>(`[data-mid="${msgId}"] .body`);
  if (node) node.innerHTML = renderMarkdown(text);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ---------------------------------------------------------------------------
// Per-tab session helpers
// ---------------------------------------------------------------------------

async function switchToTabSession(tabId: number): Promise<void> {
  const idx = await loadTabIndex();
  const convId = tabConv(idx, tabId);
  const existing = convId ? await loadConversation(convId) : null;
  conv = existing ?? newConversation(`conv-${crypto.randomUUID()}`, Date.now());
  if (!existing) {
    await saveTabIndex(setTabConv(idx, tabId, conv.id));
    await saveConversation(conv);
  }
  renderAll();
}

async function pruneTabSession(tabId: number): Promise<void> {
  const idx = await loadTabIndex();
  const { index, removedConv } = removeTab(idx, tabId);
  await saveTabIndex(index);
  if (removedConv) await deleteConversations([removedConv]);
}

// ---------------------------------------------------------------------------
// Turn lifecycle
// ---------------------------------------------------------------------------

/**
 * If a turn is in-flight, mark it aborted and render a visible error block,
 * then clear the active turn. Must be called BEFORE any conv or session swap so
 * the msgId still belongs to the current conv and renderErrorBlockFor can find it.
 */
function abortActiveTurn(reason: string): void {
  if (!active) return;
  conv = markAborted(conv, active.msgId, Date.now());
  renderErrorBlockFor(active.msgId, reason);
  saveConversation(conv).catch(() => {});
  endTurn();
}

function beginTurn(id: string, msgId: string): void {
  active = { id, msgId, state: initChatTurn(id) };
  sendBtn.disabled = true;
  stopBtn.style.display = '';
}

function endTurn(): void {
  if (active?.timeout) {
    clearTimeout(active.timeout);
  }
  active = null;
  sendBtn.disabled = false;
  stopBtn.style.display = 'none';
}

// ---------------------------------------------------------------------------
// Inbound message routing
// ---------------------------------------------------------------------------

port.onMessage.addListener((m: unknown) => {
  if (!m || typeof m !== 'object') return;
  const msg = m as Record<string, unknown>;

  if (msg.type === 'status') {
    setConnected(!!msg.connected);
    return;
  }

  if (msg.type === 'tab_bound') {
    abortActiveTurn('Tab changed — chat ended. Resend to continue.');
    boundTabId = msg.tabId as number;
    ctxChipEl.textContent = (msg.title as string) || (msg.url as string) || 'console tab';
    switchToTabSession(boundTabId).catch(() => {});
    return;
  }

  if (msg.type === 'tab_unbound' || msg.type === 'tab_inactive') {
    abortActiveTurn('Tab changed — chat ended. Resend to continue.');
    boundTabId = undefined;
    ctxChipEl.textContent = 'open an F5 XC console page';
    showInactive();
    return;
  }

  if (msg.type === 'tab_closed') {
    abortActiveTurn('Tab changed — chat ended. Resend to continue.');
    pruneTabSession(msg.tabId as number).catch(() => {});
    return;
  }

  if (msg.type === 'page_context') {
    latestContext = msg.snapshot;
    const snap = msg.snapshot as { title?: string; path?: string } | null;
    contextMeta = snap ? { title: snap.title, path: snap.path } : null;
    renderContextChip();
    return;
  }

  if (isChatInbound(m as ChatInbound)) {
    onChatEvent(m as ChatInbound);
  }
});

function onChatEvent(ev: ChatInbound): void {
  // Late inbound for a finished/aborted turn — ignore
  if (!active || active.id !== ev.id) return;

  // First inbound for this turn — clear the timeout
  if (active.timeout) {
    clearTimeout(active.timeout);
    active.timeout = undefined;
  }

  if (ev.type === 'chat_tool_notice') {
    const toolMsg = ev as ChatToolNoticeMsg;
    conv = appendToolNotice(conv, {
      id: toolMsg.id,
      tool: toolMsg.tool,
      ok: toolMsg.ok,
      detail: toolMsg.detail,
      at: Date.now(),
    });
    const node = makeToolNode(
      toolMsg.id,
      toolMsg.tool,
      toolMsg.ok,
      toolMsg.detail ?? `${toolMsg.tool}: ${toolMsg.ok ? 'ok' : 'failed'}`,
    );
    messagesEl.appendChild(node);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    scheduleSave();
    return;
  }

  // Feed ChatStreamMsg to the reducer
  const streamMsg = ev as ChatStreamMsg;
  active.state = reduceChatTurn(active.state, streamMsg);

  if (streamMsg.type === 'chat_delta') {
    conv = appendAssistantDelta(conv, active.msgId, streamMsg.delta);
    updateAssistantBody(active.msgId, active.state.text);
    scheduleSave();
  } else if (streamMsg.type === 'chat_done') {
    conv = finalizeAssistant(conv, active.msgId, active.state.references, Date.now());
    renderAll();
    saveConversation(conv).catch(() => {});
    endTurn();
  } else if (streamMsg.type === 'chat_error') {
    // Replace the streaming assistant node with a styled error block
    const existingNode = messagesEl.querySelector(`[data-mid="${active.msgId}"]`);
    if (existingNode) existingNode.remove();
    const errorNode = makeErrorNode(active.state.error ?? streamMsg.error ?? 'Unknown error');
    messagesEl.appendChild(errorNode);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    saveConversation(conv).catch(() => {});
    endTurn();
  }
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

async function sendMessage(): Promise<void> {
  const text = inputEl.value.trim();
  if (!text || active) return;

  if (!isConnected) {
    conv = appendUserMessage(conv, { id: crypto.randomUUID(), role: 'user', text, at: Date.now() });
    renderAll();
    renderErrorBlock('xcsh not connected — start the xcsh CLI, then resend.');
    await saveConversation(conv);
    inputEl.value = '';
    autosize();
    return;
  }

  inputEl.value = '';
  autosize();

  const mode = modeEl.value as InteractionMode;
  const userMsgId = `u-${crypto.randomUUID()}`;
  conv = appendUserMessage(conv, {
    id: userMsgId,
    role: 'user',
    text,
    at: Date.now(),
    context: attachContext && contextMeta ? contextMeta : undefined,
  });

  const asstMsgId = `a-${crypto.randomUUID()}`;
  conv = startAssistant(conv, asstMsgId, Date.now());
  renderAll();
  scheduleSave();

  const turnId = `c-${crypto.randomUUID()}`;
  beginTurn(turnId, asstMsgId);
  // active is guaranteed non-null immediately after beginTurn
  // biome-ignore lint/style/noNonNullAssertion: beginTurn always sets active
  const turn = active!;

  turn.timeout = setTimeout(() => {
    if (active && active.id === turnId) {
      conv = markAborted(conv, active.msgId, Date.now());
      renderErrorBlockFor(active.msgId, 'No response from xcsh (timed out). Resend to try again.');
      saveConversation(conv).catch(() => {});
      endTurn();
    }
  }, TURN_TIMEOUT_MS);

  port.postMessage(buildChatRequest(turnId, text, attachContext ? latestContext : null, mode, conv.id));
}

function autosize(): void {
  inputEl.style.height = 'auto';
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 140)}px`;
}

// ---------------------------------------------------------------------------
// Mode selector
// ---------------------------------------------------------------------------

function populateModeSelector(currentMode: InteractionMode): void {
  // Remove options built into the HTML and replace with protocol-sourced ones
  modeEl.replaceChildren();
  for (const m of INTERACTION_MODES) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    opt.title = m.blurb;
    if (m.id === currentMode) opt.selected = true;
    modeEl.appendChild(opt);
  }
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

$<HTMLFormElement>('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage().catch(() => {});
});

inputEl.addEventListener('input', autosize);

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage().catch(() => {});
  }
});

modeEl.addEventListener('change', () => {
  const value = modeEl.value as InteractionMode;
  conv = setMode(conv, value, Date.now());
  saveConversation(conv).catch(() => {});
});

$('ctx-refresh').addEventListener('click', () => {
  port.postMessage({ type: 'get_page_context' });
});

$('ctx-detach').addEventListener('click', () => {
  attachContext = !attachContext;
  renderContextChip();
});

stopBtn.addEventListener('click', () => {
  if (!active) return;
  port.postMessage(buildChatStop(active.id));
  conv = markAborted(conv, active.msgId, Date.now());
  saveConversation(conv).catch(() => {});
  renderAll();
  endTurn();
});

// ---------------------------------------------------------------------------
// Boot: show inactive state; session is set by first tab_bound from the SW
// ---------------------------------------------------------------------------

(async () => {
  // Start with a blank placeholder conversation (shown as inactive until tab binds)
  conv = newConversation(`conv-${crypto.randomUUID()}`, Date.now());

  populateModeSelector(conv.mode);
  renderAll();
  ctxChipEl.textContent = 'open an F5 XC console page';

  port.postMessage({ type: 'status_request' });
  port.postMessage({ type: 'get_page_context' });
})();
