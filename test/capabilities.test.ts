import { describe, expect, it } from 'bun:test';
import {
  buildCapabilities,
  CONTRACT_VERSION,
  FEATURES,
  getToolDef,
  TOOLS,
  toolNames,
  validateToolParams,
} from '../src/capabilities';
import { INTERACTION_MODES } from '../src/chat-protocol';

// The authoritative set of tools the extension dispatches (the `dispatchTool`
// switch), plus the new `capabilities` discovery tool. The descriptor MUST cover
// exactly these — no more, no less.
const EXPECTED_TOOLS = [
  'ping',
  'reload',
  'debug_exec',
  'navigate',
  'login',
  'select_option',
  'scroll_to',
  'get_page_text',
  'javascript_tool',
  'tabs_list',
  'tabs_create',
  'tabs_close',
  'resize_window',
  'read_console',
  'read_network',
  'diag_suspension',
  'diag_bridges',
  'capture_login_flow',
  'wait_for_api_response',
  'file_upload',
  'browser_batch',
  'read_ax',
  'query_dom',
  'wait_for',
  'assert_text',
  'find',
  'click',
  'click_element',
  'click_xy',
  'type_text',
  'screenshot',
  'form_input',
  'key_press',
  'label_select',
  'detach',
  'set_explain_mode',
  'set_bridge_port',
  'annotate',
  'capabilities',
  'get_page_context',
];

describe('capabilities — tool descriptors', () => {
  it('describes exactly the dispatchable tools (plus capabilities)', () => {
    expect(toolNames().slice().sort()).toEqual(EXPECTED_TOOLS.slice().sort());
  });

  it('every tool has a non-empty name, summary, category, and a params schema', () => {
    for (const t of TOOLS) {
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.summary.length).toBeGreaterThan(0);
      expect(t.category.length).toBeGreaterThan(0);
      expect(t.params).toBeDefined();
    }
  });

  it('tool names are unique', () => {
    const names = toolNames();
    expect(new Set(names).size).toBe(names.length);
  });

  it('getToolDef returns the matching def, or undefined for an unknown tool', () => {
    expect(getToolDef('click')?.name).toBe('click');
    expect(getToolDef('does_not_exist')).toBeUndefined();
  });
});

describe('capabilities — param validation', () => {
  it('accepts params that satisfy a tool schema', () => {
    expect(validateToolParams('click', { ref: 'e12' }).ok).toBe(true);
    expect(validateToolParams('click_xy', { x: 10, y: 20 }).ok).toBe(true);
    expect(validateToolParams('ping', {}).ok).toBe(true);
  });

  it('rejects a missing required field, naming the tool in the error', () => {
    const r = validateToolParams('click', {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('click');
  });

  it('rejects a field of the wrong type', () => {
    expect(validateToolParams('click_xy', { x: 'nope', y: 20 }).ok).toBe(false);
    expect(validateToolParams('resize_window', { width: 800 }).ok).toBe(false); // height missing
  });

  it('accepts optional fields omitted and rejects an unknown tool', () => {
    expect(validateToolParams('read_console', {}).ok).toBe(true); // pattern optional
    const r = validateToolParams('not_a_tool', {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('not_a_tool');
  });
});

describe('capabilities — features & manifest', () => {
  it('CONTRACT_VERSION is a non-empty string', () => {
    expect(typeof CONTRACT_VERSION).toBe('string');
    expect(CONTRACT_VERSION.length).toBeGreaterThan(0);
  });

  it('CONTRACT_VERSION is 1.5.0 (multiPortDiscovery + diag_bridges)', () => {
    expect(CONTRACT_VERSION).toBe('1.5.0');
  });

  it('publishes agent-behavior promptHints sourced from INTERACTION_MODES', () => {
    const chat = (buildCapabilities('0.0.0').features as Record<string, unknown>).chat as {
      modes: readonly string[];
      promptHints?: {
        role: string;
        grounding: string;
        referenceLinks: string;
        toolUse: string;
        modes: Record<string, string>;
      };
    };
    const hints = chat.promptHints;
    expect(hints).toBeDefined();
    for (const k of ['role', 'grounding', 'referenceLinks', 'toolUse'] as const) {
      expect(typeof hints?.[k]).toBe('string');
      expect((hints?.[k] as string).length).toBeGreaterThan(0);
    }
    // Mode hints cover exactly the advertised modes and match the single source.
    expect(Object.keys(hints?.modes ?? {}).sort()).toEqual([...chat.modes].sort());
    for (const m of INTERACTION_MODES) {
      expect(hints?.modes[m.id]).toBe(m.blurb);
    }
  });

  it('every FEATURE points at a tool that exists', () => {
    expect(getToolDef(FEATURES.explainMode.tool)).toBeDefined();
    expect(getToolDef(FEATURES.overlays.tool)).toBeDefined();
    expect(getToolDef(FEATURES.capture.tool)).toBeDefined();
    expect(getToolDef(FEATURES.viewport.tool)).toBeDefined();
    expect(getToolDef(FEATURES.chat.contextTool)).toBeDefined();
  });

  it('overlays advertise the registered kinds', () => {
    expect(FEATURES.overlays.kinds).toContain('fingerprint');
    expect(FEATURES.overlays.kinds).toContain('highlight');
  });

  it('flags annotate as explain-mode-gated; reads as read-only; clicks as mutating', () => {
    expect(getToolDef('annotate')?.flags?.requiresExplainMode).toBe(true);
    expect(getToolDef('read_ax')?.flags?.readOnly).toBe(true);
    expect(getToolDef('click')?.flags?.mutates).toBe(true);
  });

  it('publishes get_page_context as a read-only tool', () => {
    const def = getToolDef('get_page_context');
    expect(def).toBeDefined();
    expect(def?.category).toBe('read');
    expect(def?.flags?.readOnly).toBe(true);
  });

  it('advertises the chat feature with its protocol messages and modes', () => {
    const cap = buildCapabilities('0.1.0');
    const chat = (cap.features as Record<string, unknown>).chat as {
      modes?: readonly string[];
      messages?: readonly string[];
    };
    expect(chat).toBeDefined();
    expect(chat?.modes).toEqual(['educational', 'presentation', 'configuration', 'screenshot', 'annotation']);
    expect(chat?.messages).toEqual([
      'chat_request',
      'chat_delta',
      'chat_done',
      'chat_error',
      'chat_stop',
      'chat_tool_notice',
    ]);
    expect(chat?.messages).toContain('chat_stop');
    expect(chat?.messages).toContain('chat_tool_notice');
  });

  it('buildCapabilities assembles the runtime manifest', () => {
    const cap = buildCapabilities('9.9.9');
    expect(cap.version).toBe('9.9.9');
    expect(cap.contractVersion).toBe(CONTRACT_VERSION);
    expect(cap.protocol).toBe('tool_request/result');
    expect(cap.tools.length).toBe(toolNames().length);
    expect(cap.features.overlays.kinds).toContain('highlight');
  });
});
