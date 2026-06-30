/**
 * Machine-readable conformance schemas for the chat bridge wire protocol, plus
 * golden valid/invalid examples. PURE (TypeBox only). This is the cross-repo
 * contract: the extension and xcsh both validate against the same schemas +
 * examples (published as `chat-conformance.json`), so the two sides cannot drift
 * silently. The hand-written interfaces in `chat-protocol.ts` stay the in-code
 * types; the examples below are typed against them for compile-time lockstep,
 * and validated against the schemas at runtime (see test/chat-conformance.test.ts).
 */

import { type TSchema, Type } from '@sinclair/typebox';
import type {
  ChatDeltaMsg,
  ChatDoneMsg,
  ChatErrorMsg,
  ChatRequestMsg,
  ChatStopMsg,
  ChatToolNoticeMsg,
} from './chat-protocol';
import type { PageContextSnapshot } from './context-snapshot';

// Chat turn ids are prefixed `c-`, disjoint from tool-request ids.
const ChatId = Type.String({ pattern: '^c-' });

export const InteractionModeSchema = Type.Union([
  Type.Literal('educational'),
  Type.Literal('presentation'),
  Type.Literal('configuration'),
  Type.Literal('screenshot'),
  Type.Literal('annotation'),
]);

export const ChatReferenceSchema = Type.Object({
  kind: Type.String(), // 'doc' | 'console' (string-open for forward-compat)
  title: Type.String(),
  url: Type.String(),
});

export const SnapshotApiSchema = Type.Object({
  url: Type.String(),
  status: Type.Number(),
  resourceType: Type.Union([Type.String(), Type.Null()]),
  body: Type.Unknown(),
  truncated: Type.Boolean(),
});

export const PageContextSnapshotSchema = Type.Object({
  v: Type.Literal(1),
  capturedAt: Type.Number(),
  tabId: Type.Number(),
  url: Type.String(),
  path: Type.String(),
  title: Type.String(),
  ax: Type.Union([Type.Null(), Type.Object({ role: Type.String() }, { additionalProperties: true })]),
  api: Type.Union([Type.Null(), SnapshotApiSchema]),
  truncated: Type.Boolean(),
});

export const ChatRequestSchema = Type.Object({
  type: Type.Literal('chat_request'),
  id: ChatId,
  text: Type.String(),
  context: Type.Union([Type.Null(), PageContextSnapshotSchema]),
  mode: InteractionModeSchema,
  history_hint: Type.Optional(Type.String()),
});

export const ChatStopSchema = Type.Object({
  type: Type.Literal('chat_stop'),
  id: ChatId,
});

export const ChatDeltaSchema = Type.Object({
  type: Type.Literal('chat_delta'),
  id: ChatId,
  seq: Type.Number(),
  delta: Type.String(),
});

export const ChatDoneSchema = Type.Object({
  type: Type.Literal('chat_done'),
  id: ChatId,
  references: Type.Optional(Type.Array(ChatReferenceSchema)),
});

export const ChatErrorSchema = Type.Object({
  type: Type.Literal('chat_error'),
  id: ChatId,
  error: Type.String(),
});

export const ChatToolNoticeSchema = Type.Object({
  type: Type.Literal('chat_tool_notice'),
  id: ChatId,
  tool: Type.String(),
  ok: Type.Boolean(),
  detail: Type.Optional(Type.String()),
});

/** Wire-message schemas keyed by `type`. */
export const CHAT_SCHEMAS: Record<string, TSchema> = {
  chat_request: ChatRequestSchema,
  chat_stop: ChatStopSchema,
  chat_delta: ChatDeltaSchema,
  chat_done: ChatDoneSchema,
  chat_error: ChatErrorSchema,
  chat_tool_notice: ChatToolNoticeSchema,
};

// --- Golden examples (independent oracles, validated against the schemas) -----

const SNAPSHOT_EXAMPLE: PageContextSnapshot = {
  v: 1,
  capturedAt: 1719000000000,
  tabId: 7,
  url: 'https://acme.console.ves.volterra.io/web/namespaces/default/http_loadbalancers/lb1',
  path: '/web/namespaces/default/http_loadbalancers/lb1',
  title: 'lb1 — Distributed Cloud',
  ax: { role: 'WebArea', name: 'lb1', children: [{ role: 'button', name: 'Edit', ref: 'e12' }] },
  api: {
    url: '/api/config/namespaces/default/http_loadbalancers/lb1',
    status: 200,
    resourceType: 'http_loadbalancers',
    body: { metadata: { name: 'lb1' }, spec: { domains: ['lb1.example.com'] } },
    truncated: false,
  },
  truncated: false,
};

// Each valid example is typed as its wire interface (compile-time lockstep) AND
// validated against its schema at runtime (test/chat-conformance.test.ts).
const chatRequest: ChatRequestMsg = {
  type: 'chat_request',
  id: 'c-1111',
  text: 'What does this load balancer do?',
  context: SNAPSHOT_EXAMPLE,
  mode: 'educational',
  history_hint: 'conv-1',
};
const chatRequestNoContext: ChatRequestMsg = {
  type: 'chat_request',
  id: 'c-2222',
  text: 'help me build a WAF policy',
  context: null,
  mode: 'configuration',
};
const chatStop: ChatStopMsg = { type: 'chat_stop', id: 'c-1111' };
const chatDelta: ChatDeltaMsg = { type: 'chat_delta', id: 'c-1111', seq: 0, delta: 'This LB ' };
const chatDelta1: ChatDeltaMsg = { type: 'chat_delta', id: 'c-1111', seq: 1, delta: 'routes traffic.' };
const chatDone: ChatDoneMsg = {
  type: 'chat_done',
  id: 'c-1111',
  references: [{ kind: 'doc', title: 'HTTP LB', url: 'https://docs.cloud.f5.com/docs/how-to' }],
};
const chatDoneNoRefs: ChatDoneMsg = { type: 'chat_done', id: 'c-1111' };
const chatError: ChatErrorMsg = { type: 'chat_error', id: 'c-1111', error: 'HTTP 403 forbidden' };
const chatToolNotice: ChatToolNoticeMsg = { type: 'chat_tool_notice', id: 'c-1111', tool: 'navigate', ok: true };

export const CHAT_EXAMPLES = {
  valid: {
    page_context_snapshot: SNAPSHOT_EXAMPLE,
    chat_request: chatRequest,
    chat_request_no_context: chatRequestNoContext,
    chat_stop: chatStop,
    chat_delta: chatDelta,
    chat_delta_1: chatDelta1,
    chat_done: chatDone,
    chat_done_no_refs: chatDoneNoRefs,
    chat_error: chatError,
    chat_tool_notice: chatToolNotice,
  },
  // Invalid examples are intentionally malformed; each `schema` names the schema
  // it must be REJECTED by.
  invalid: [
    { schema: 'chat_request', why: 'id missing c- prefix', value: { ...chatRequest, id: 'x-1111' } },
    { schema: 'chat_request', why: 'unknown mode', value: { ...chatRequest, mode: 'wizard' } },
    {
      schema: 'chat_request',
      why: 'missing text',
      value: { type: 'chat_request', id: 'c-1', context: null, mode: 'educational' },
    },
    { schema: 'chat_delta', why: 'missing seq', value: { type: 'chat_delta', id: 'c-1', delta: 'x' } },
    { schema: 'page_context_snapshot', why: 'wrong version', value: { ...SNAPSHOT_EXAMPLE, v: 2 } },
  ] as const,
};
