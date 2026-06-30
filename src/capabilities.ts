/**
 * The extension's self-describing capability contract — the single source of
 * truth for what the extension can do.
 *
 * `TOOLS` describes every tool the bridge dispatches, with a TypeBox params
 * schema (a TypeBox schema IS a JSON Schema, the same representation xcsh uses,
 * so its interface + LLM tool defs can be generated from this with zero
 * friction). `FEATURES` describes the higher-level capabilities (explain mode,
 * the overlay library, capture, viewport). `capabilities.json` is generated from
 * this module and a `capabilities` tool serves it at runtime, so xcsh discovers
 * the contract instead of mirroring it by hand.
 *
 * Pure and chrome-free on purpose: the build-time generator and the service
 * worker both import it (the handlers live in the worker, paired to these
 * descriptors by name at dispatch).
 */

import { type TSchema, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { INTERACTION_MODES } from './chat-protocol';

/** Bumped on any change to the tool/feature contract so xcsh can detect drift. */
export const CONTRACT_VERSION = '1.4.0';

export type ToolCategory = 'navigation' | 'interaction' | 'read' | 'script' | 'annotation' | 'meta';

export interface ToolFlags {
  /** Pure read; no page or state change. */
  readonly readOnly?: boolean;
  /** Changes the page, navigation, tabs, window, or extension state. */
  readonly mutates?: boolean;
  /** Only takes effect while explain mode is on. */
  readonly requiresExplainMode?: boolean;
}

export interface ToolDef {
  readonly name: string;
  readonly summary: string;
  readonly category: ToolCategory;
  readonly params: TSchema;
  readonly flags?: ToolFlags;
}

const empty = Type.Object({});

const BASE_TOOLS: readonly Omit<ToolDef, 'flags'>[] = [
  // --- meta -----------------------------------------------------------------
  { name: 'ping', summary: 'Liveness check; returns { ok, version }.', category: 'meta', params: empty },
  {
    name: 'capabilities',
    summary: 'Return this self-describing capability manifest (tools + features + versions).',
    category: 'meta',
    params: empty,
  },
  { name: 'reload', summary: 'Reload the extension (re-reads dist/ from disk).', category: 'meta', params: empty },
  { name: 'debug_exec', summary: 'Diagnostic: probe in-page bridge availability.', category: 'meta', params: empty },
  { name: 'detach', summary: 'Detach the debugger from the target tab.', category: 'meta', params: empty },
  {
    name: 'set_bridge_port',
    summary: 'Set the WebSocket bridge port (persists across reload; enables multi-session on different ports).',
    category: 'meta',
    params: Type.Object({ port: Type.Number() }),
  },

  // --- navigation -----------------------------------------------------------
  {
    name: 'navigate',
    summary: 'Navigate the console tab to a scoped https URL.',
    category: 'navigation',
    params: Type.Object({ url: Type.String() }),
  },
  {
    name: 'login',
    summary: 'Drive the F5 XC OIDC/Keycloak login end-to-end.',
    category: 'navigation',
    params: Type.Object({ email: Type.String(), password: Type.String(), consoleUrl: Type.String() }),
  },
  {
    name: 'scroll_to',
    summary: 'Scroll an AX-ref element into view.',
    category: 'navigation',
    params: Type.Object({ ref: Type.String() }),
  },
  {
    name: 'resize_window',
    summary: 'Resize the browser window.',
    category: 'navigation',
    params: Type.Object({ width: Type.Number(), height: Type.Number() }),
  },
  { name: 'tabs_list', summary: 'List scoped console tabs.', category: 'navigation', params: empty },
  {
    name: 'tabs_create',
    summary: 'Open a new tab at a scoped URL.',
    category: 'navigation',
    params: Type.Object({ url: Type.String() }),
  },
  {
    name: 'tabs_close',
    summary: 'Close a tab by id.',
    category: 'navigation',
    params: Type.Object({ tabId: Type.Number() }),
  },

  // --- interaction ----------------------------------------------------------
  {
    name: 'click',
    summary: 'Deterministic click of an AX-ref element (layout-engine coords + hit-test).',
    category: 'interaction',
    params: Type.Object({ ref: Type.String() }),
  },
  {
    name: 'click_element',
    summary: 'Click the element returned by a JS expression (polls; occlusion-safe).',
    category: 'interaction',
    params: Type.Object({ js: Type.String(), wait_ms: Type.Optional(Type.Number()) }),
  },
  {
    name: 'click_xy',
    summary: 'Trusted click at explicit viewport coordinates.',
    category: 'interaction',
    params: Type.Object({ x: Type.Number(), y: Type.Number() }),
  },
  {
    name: 'type_text',
    summary: 'Type text into the focused element (trusted input).',
    category: 'interaction',
    params: Type.Object({ text: Type.String() }),
  },
  {
    name: 'form_input',
    summary: 'Set a form field value by AX ref.',
    category: 'interaction',
    params: Type.Object({ ref: Type.String(), value: Type.String() }),
  },
  {
    name: 'key_press',
    summary: 'Dispatch a key press.',
    category: 'interaction',
    params: Type.Object({ key: Type.String() }),
  },
  {
    name: 'select_option',
    summary: 'Select an option in a native <select> by AX ref.',
    category: 'interaction',
    params: Type.Object({ ref: Type.String(), value: Type.String() }),
  },
  {
    name: 'label_select',
    summary: 'Type into a CDK-portal typeahead and click the matching option.',
    category: 'interaction',
    params: Type.Object({
      selector: Type.String(),
      value: Type.String(),
      label_value: Type.Optional(Type.String()),
      wait_ms: Type.Optional(Type.Number()),
    }),
  },
  {
    name: 'file_upload',
    summary: 'Upload files (base64 data URIs) to a file input by AX ref.',
    category: 'interaction',
    params: Type.Object({ ref: Type.String(), files: Type.Array(Type.String()) }),
  },

  // --- read -----------------------------------------------------------------
  { name: 'read_ax', summary: 'Read the accessibility tree of the page.', category: 'read', params: empty },
  { name: 'get_page_text', summary: 'Return the page text.', category: 'read', params: empty },
  {
    name: 'query_dom',
    summary: 'Direct DOM.querySelector at wire speed — bypasses Runtime.evaluate for simple CSS selectors.',
    category: 'read',
    params: Type.Object({ selector: Type.String() }),
  },
  {
    name: 'find',
    summary: 'Find AX nodes matching a locator.',
    category: 'read',
    params: Type.Object({ selector: Type.String() }),
  },
  {
    name: 'wait_for',
    summary: 'Wait for an AX node matching a locator to appear.',
    category: 'read',
    params: Type.Object({
      selector: Type.String(),
      context: Type.Optional(Type.String()),
      timeoutMs: Type.Optional(Type.Number()),
    }),
  },
  {
    name: 'assert_text',
    summary: 'Assert an element contains expected text.',
    category: 'read',
    params: Type.Object({
      selector: Type.String(),
      expected: Type.String(),
      context: Type.Optional(Type.String()),
    }),
  },
  { name: 'screenshot', summary: 'Capture a screenshot (base64 PNG).', category: 'read', params: empty },
  {
    name: 'read_console',
    summary: 'Read buffered console messages, optionally filtered by pattern.',
    category: 'read',
    params: Type.Object({ pattern: Type.Optional(Type.String()) }),
  },
  {
    name: 'read_network',
    summary: 'Read buffered network events, optionally filtered by pattern.',
    category: 'read',
    params: Type.Object({ pattern: Type.Optional(Type.String()) }),
  },
  {
    name: 'wait_for_api_response',
    summary: 'Wait for a network response whose URL matches a pattern.',
    category: 'read',
    params: Type.Object({ pattern: Type.Optional(Type.String()), timeout_ms: Type.Optional(Type.Number()) }),
  },
  {
    name: 'get_page_context',
    summary: 'Return a snapshot of the active console page (url, AX tree, captured XC API body) for chat grounding.',
    category: 'read',
    params: empty,
  },

  // --- script ---------------------------------------------------------------
  {
    name: 'javascript_tool',
    summary: 'Evaluate arbitrary JS in the page (length-capped).',
    category: 'script',
    params: Type.Object({ code: Type.String() }),
  },
  {
    name: 'browser_batch',
    summary: 'Run a batch of { tool, params } actions in sequence.',
    category: 'script',
    params: Type.Object({
      actions: Type.Array(Type.Object({ tool: Type.String(), params: Type.Optional(Type.Unknown()) })),
    }),
  },

  // --- annotation -----------------------------------------------------------
  {
    name: 'set_explain_mode',
    summary: 'Enter/leave explain mode — the gate for all on-page annotation overlays.',
    category: 'annotation',
    params: Type.Object({ enabled: Type.Optional(Type.Boolean()) }),
  },
  {
    name: 'annotate',
    summary: 'Draw an overlay annotation (fingerprint/highlight). No-op unless explain mode is on.',
    category: 'annotation',
    params: Type.Object({
      kind: Type.String(),
      ref: Type.Optional(Type.String()),
      x: Type.Optional(Type.Number()),
      y: Type.Optional(Type.Number()),
      w: Type.Optional(Type.Number()),
      h: Type.Optional(Type.Number()),
    }),
  },
];

// Semantic flags, classified centrally (auditable in one place) rather than
// scattered across every literal.
const READ_ONLY = new Set([
  'ping',
  'capabilities',
  'debug_exec',
  'read_ax',
  'get_page_text',
  'query_dom',
  'find',
  'wait_for',
  'assert_text',
  'screenshot',
  'read_console',
  'read_network',
  'wait_for_api_response',
  'get_page_context',
]);
const MUTATING = new Set([
  'set_bridge_port',
  'navigate',
  'login',
  'scroll_to',
  'resize_window',
  'tabs_create',
  'tabs_close',
  'click',
  'click_element',
  'click_xy',
  'type_text',
  'form_input',
  'key_press',
  'select_option',
  'label_select',
  'file_upload',
  'javascript_tool',
  'browser_batch',
  'reload',
  'detach',
]);
const EXPLAIN_GATED = new Set(['annotate']);

function deriveFlags(name: string): ToolFlags {
  const flags: { readOnly?: boolean; mutates?: boolean; requiresExplainMode?: boolean } = {};
  if (READ_ONLY.has(name)) flags.readOnly = true;
  if (MUTATING.has(name)) flags.mutates = true;
  if (EXPLAIN_GATED.has(name)) flags.requiresExplainMode = true;
  return flags;
}

/** The tools, enriched with derived semantic flags. */
export const TOOLS: readonly ToolDef[] = BASE_TOOLS.map((t) => ({ ...t, flags: deriveFlags(t.name) }));

/**
 * Agent-facing behavioral contract (layer 2 of the chat contract). xcsh is an
 * interactive LLM agent, not a script runner — these hints must live in its
 * system prompt, so they are published here as the single source. Mode hints are
 * sourced from INTERACTION_MODES so a mode has exactly one definition.
 */
const CHAT_PROMPT_HINTS = {
  role: 'You are xcsh, the AI assistant embedded in the F5 Distributed Cloud (XC) console side panel. The user is viewing a live console page; help them drive automation and understand settings and their purpose.',
  grounding:
    'Every user message carries a page-context snapshot: url/path, title, a trimmed accessibility tree, and — when available — the live XC API resource JSON the page loaded (context.api.body). Treat context.api.body as the authoritative current state of the resource and ground answers in it instead of guessing; respect the truncated flags.',
  referenceLinks:
    'Emit every citation as a markdown link [title](url): F5 XC docs (docs.cloud.f5.com) as doc references and the tenant console host as console deep-links. These populate the panel References drawer, so always format references this way rather than as bare URLs.',
  toolUse:
    'Drive the console with the extension tools via the normal tool_request flow (navigate, click, annotate, screenshot, get_page_context, and so on). The extension surfaces tool activity to the panel itself (chat_tool_notice) — never emit chat_tool_notice yourself. Each turn ends with exactly one terminal frame, which the transport handles.',
  modes: Object.fromEntries(INTERACTION_MODES.map((m) => [m.id, m.blurb])) as Record<string, string>,
};

/** Higher-level capabilities, each pointing at the tool(s) that drive it. */
export const FEATURES = {
  explainMode: {
    tool: 'set_explain_mode',
    default: false,
    description:
      'A deliberate, human-paced walkthrough mode. While on, on-page annotation overlays are shown; off by default (fast automation shows nothing).',
  },
  overlays: {
    tool: 'annotate',
    requiresExplainMode: true,
    autoFingerprintOnClick: true,
    kinds: ['fingerprint', 'highlight'] as const,
    description:
      'Transient annotation overlays. In explain mode, clicks auto-draw a fingerprint; `annotate` draws a named overlay by ref or coordinates.',
  },
  capture: {
    tool: 'screenshot',
    description: 'Capture a screenshot (base64 PNG) — for headless annotated-capture flows.',
  },
  viewport: {
    tool: 'resize_window',
    description: 'Control the browser window size.',
  },
  chat: {
    contextTool: 'get_page_context',
    transport: 'websocket-bridge',
    modes: ['educational', 'presentation', 'configuration', 'screenshot', 'annotation'] as const,
    messages: ['chat_request', 'chat_delta', 'chat_done', 'chat_error', 'chat_stop', 'chat_tool_notice'] as const,
    description:
      'User ↔ xcsh chat over the bridge. The extension side panel sends chat_request (with mode and page-context snapshot); xcsh streams chat_delta tokens then a terminal chat_done (with reference links) or chat_error. Chat ids are prefixed "c-". Tool calls during a turn use the normal tool_request flow. chat_stop halts a streaming response. chat_tool_notice is emitted by the EXTENSION (the service worker) to the panel as a best-effort UI signal when a tool runs during a turn — it is NOT sent by xcsh; xcsh must not produce it to avoid double-rendering in the panel.',
    promptHints: CHAT_PROMPT_HINTS,
  },
} as const;

export interface CapabilityManifest {
  readonly version: string;
  readonly contractVersion: string;
  readonly protocol: 'tool_request/result';
  readonly tools: readonly ToolDef[];
  readonly features: typeof FEATURES;
}

/** Assemble the runtime capability manifest (served by the `capabilities` tool). */
export function buildCapabilities(version: string): CapabilityManifest {
  return {
    version,
    contractVersion: CONTRACT_VERSION,
    protocol: 'tool_request/result',
    tools: TOOLS,
    features: FEATURES,
  };
}

const BY_NAME = new Map<string, ToolDef>(TOOLS.map((t) => [t.name, t]));

/** All tool names, in declaration order. */
export function toolNames(): string[] {
  return TOOLS.map((t) => t.name);
}

/** Look up a tool descriptor by name. */
export function getToolDef(name: string): ToolDef | undefined {
  return BY_NAME.get(name);
}

export type ValidationResult = { ok: true } | { ok: false; error: string };

/**
 * Validate a tool's params against its schema. Returns a deterministic error
 * (naming the tool) for an unknown tool or a schema violation — the basis for
 * rejecting malformed calls at dispatch.
 */
export function validateToolParams(name: string, params: unknown): ValidationResult {
  const def = BY_NAME.get(name);
  if (!def) return { ok: false, error: `unknown tool: ${name}` };
  if (Value.Check(def.params, params)) return { ok: true };
  const first = [...Value.Errors(def.params, params)][0];
  const at = first?.path ? ` at ${first.path}` : '';
  return { ok: false, error: `${name}: ${first ? first.message : 'invalid params'}${at}` };
}
