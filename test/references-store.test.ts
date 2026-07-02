import { describe, expect, it } from 'bun:test';
import { DEFAULT_MODE } from '../src/chat-protocol';
import {
  addToIndex,
  appendAssistantDelta,
  appendToolNotice,
  appendUserMessage,
  type ChatIndex,
  CONV_CAP,
  deriveTitle,
  emptySessionIndex,
  emptyTabIndex,
  finalizeAssistant,
  markAborted,
  newConversation,
  pruneConversations,
  removeTab,
  removeTabSession,
  sessionIndexFromTabIndex,
  setMode,
  setTabConv,
  setTenantConv,
  startAssistant,
  tabConv,
  tabSessionKey,
  tenantConv,
} from '../src/references-store';

describe('conversation lifecycle', () => {
  it('titles from the first user message and streams an assistant reply', () => {
    let c = newConversation('conv-1', 1);
    c = appendUserMessage(c, { id: 'm1', role: 'user', text: 'How do I configure a WAF?', at: 2 });
    expect(c.title).toBe(deriveTitle('How do I configure a WAF?'));
    c = startAssistant(c, 'm2', 3);
    c = appendAssistantDelta(c, 'm2', 'Open ');
    c = appendAssistantDelta(c, 'm2', 'the LB.');
    expect(c.messages[1].text).toBe('Open the LB.');
  });

  it('collects + dedupes references by url on finalize', () => {
    let c = newConversation('conv-1', 1);
    c = startAssistant(c, 'm1', 2);
    c = finalizeAssistant(
      c,
      'm1',
      [
        { kind: 'doc', title: 'WAF', url: 'https://d/waf' },
        { kind: 'doc', title: 'WAF dup', url: 'https://d/waf' },
        { kind: 'console', title: 'Open', url: 'https://c/lb' },
      ],
      3,
    );
    expect(c.references).toHaveLength(2);
    expect(c.messages[0].refs).toHaveLength(2);
    expect(c.references.every((r) => r.firstSeenMsg === 'm1')).toBe(true);
  });
});

describe('pruneConversations', () => {
  it('drops oldest beyond the cap', () => {
    let idx: ChatIndex = { conversations: [], active: null };
    for (let i = 0; i < CONV_CAP + 3; i++) idx = addToIndex(idx, `conv-${i}`);
    const { index, removed } = pruneConversations(idx);
    expect(index.conversations).toHaveLength(CONV_CAP);
    expect(removed).toEqual(['conv-0', 'conv-1', 'conv-2']);
  });
});

describe('interaction modes and tool entries (addendum)', () => {
  it('creates conversation with DEFAULT_MODE', () => {
    const c = newConversation('conv-1', 1);
    expect(c.mode).toBe(DEFAULT_MODE);
  });

  it('setMode updates mode and updatedAt', () => {
    let c = newConversation('conv-1', 1);
    c = setMode(c, 'presentation', 42);
    expect(c.mode).toBe('presentation');
    expect(c.updatedAt).toBe(42);
  });

  it('can create conversation with explicit mode', () => {
    const c = newConversation('conv-1', 1, 'configuration');
    expect(c.mode).toBe('configuration');
  });

  it('appendToolNotice appends a tool entry with minimal text', () => {
    let c = newConversation('conv-1', 1);
    c = appendToolNotice(c, { id: 't1', tool: 'waf-config', ok: true, at: 2 });
    expect(c.messages).toHaveLength(1);
    const msg = c.messages[0];
    expect(msg.role).toBe('tool');
    expect(msg.tool).toBe('waf-config');
    expect(msg.ok).toBe(true);
    expect(msg.text).toBe('waf-config: ok');
  });

  it('appendToolNotice with detail uses detail', () => {
    let c = newConversation('conv-1', 1);
    c = appendToolNotice(c, { id: 't1', tool: 'waf-config', ok: false, detail: 'Invalid JSON', at: 2 });
    expect(c.messages[0].text).toBe('Invalid JSON');
  });

  it('markAborted sets aborted flag on assistant message', () => {
    let c = newConversation('conv-1', 1);
    c = startAssistant(c, 'm1', 2);
    c = appendAssistantDelta(c, 'm1', 'Starting response...');
    const beforeTime = c.updatedAt;
    c = markAborted(c, 'm1', 5);
    expect(c.messages[0].aborted).toBe(true);
    expect(c.updatedAt).toBe(5);
    expect(c.updatedAt).toBeGreaterThan(beforeTime);
  });

  it('markAborted does not affect other messages', () => {
    let c = newConversation('conv-1', 1);
    c = appendUserMessage(c, { id: 'u1', role: 'user', text: 'Hello', at: 2 });
    c = startAssistant(c, 'a1', 3);
    c = appendAssistantDelta(c, 'a1', 'Hi');
    c = startAssistant(c, 'a2', 4);
    c = appendAssistantDelta(c, 'a2', 'Another');
    c = markAborted(c, 'a1', 5);
    expect(c.messages[0].role).toBe('user');
    expect(c.messages[0].aborted).toBeUndefined();
    expect(c.messages[1].aborted).toBe(true);
    expect(c.messages[2].aborted).toBeUndefined();
  });
});

describe('SessionIndex (per-tenant session map)', () => {
  it('maps many tabs of one tenant to a single conversation', () => {
    let idx = emptySessionIndex();
    idx = setTenantConv(idx, 'acme|staging', 10, 'conv-acme');
    idx = setTenantConv(idx, 'acme|staging', 11, 'conv-acme'); // second tab, same tenant
    expect(tenantConv(idx, 'acme|staging')).toBe('conv-acme');
    expect(tabSessionKey(idx, 10)).toBe('acme|staging');
    expect(tabSessionKey(idx, 11)).toBe('acme|staging');
  });
  it('keeps conversations distinct across tenants and environments', () => {
    let idx = emptySessionIndex();
    idx = setTenantConv(idx, 'acme|staging', 10, 'conv-a-stg');
    idx = setTenantConv(idx, 'acme|production', 20, 'conv-a-prod');
    idx = setTenantConv(idx, 'globex|staging', 30, 'conv-g-stg');
    expect(tenantConv(idx, 'acme|staging')).toBe('conv-a-stg');
    expect(tenantConv(idx, 'acme|production')).toBe('conv-a-prod');
    expect(tenantConv(idx, 'globex|staging')).toBe('conv-g-stg');
  });
  it('removing a tab keeps the tenant conversation (many-tabs -> one-session)', () => {
    let idx = setTenantConv(
      setTenantConv(emptySessionIndex(), 'acme|staging', 10, 'conv-a'),
      'acme|staging',
      11,
      'conv-a',
    );
    idx = removeTabSession(idx, 10);
    expect(tabSessionKey(idx, 10)).toBeUndefined();
    expect(tabSessionKey(idx, 11)).toBe('acme|staging');
    expect(tenantConv(idx, 'acme|staging')).toBe('conv-a'); // conv persists for tab 11 / future tabs
  });
  it('migrates an old TabIndex using resolved session keys', () => {
    const idx = sessionIndexFromTabIndex([
      { tabId: 5, sessionKey: 'acme|staging', convId: 'conv-old-5' },
      { tabId: 6, sessionKey: 'acme|staging', convId: 'conv-old-5' },
      { tabId: 7, sessionKey: 'globex|production', convId: 'conv-old-7' },
    ]);
    expect(tenantConv(idx, 'acme|staging')).toBe('conv-old-5');
    expect(tenantConv(idx, 'globex|production')).toBe('conv-old-7');
    expect(tabSessionKey(idx, 6)).toBe('acme|staging');
  });
});

describe('TabIndex (per-tab session map)', () => {
  it('maps a tab id to a conversation id immutably', () => {
    const a = emptyTabIndex();
    const b = setTabConv(a, 7, 'conv-7');
    expect(tabConv(b, 7)).toBe('conv-7');
    expect(tabConv(a, 7)).toBeUndefined(); // original unchanged
  });
  it('removes a tab and returns the conversation it pointed at', () => {
    const idx = setTabConv(setTabConv(emptyTabIndex(), 7, 'conv-7'), 8, 'conv-8');
    const { index, removedConv } = removeTab(idx, 7);
    expect(removedConv).toBe('conv-7');
    expect(tabConv(index, 7)).toBeUndefined();
    expect(tabConv(index, 8)).toBe('conv-8');
    expect(removeTab(index, 99).removedConv).toBeUndefined();
  });
});
