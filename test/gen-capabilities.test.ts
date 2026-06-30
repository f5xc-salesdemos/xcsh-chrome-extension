import { describe, expect, it } from 'bun:test';
import { formatBiomeJson } from '../scripts/gen-capabilities';

// The generator must emit JSON that Biome's formatter (the repo's `biome ci .`
// authority) leaves untouched: non-empty objects expand one-per-line, while
// short arrays collapse onto a single line if they fit within 120 columns.
// (The end-to-end guarantee is `biome ci capabilities.json` in CI; these tests
// pin the serializer's behavior directly so regressions are caught in unit.)
describe('formatBiomeJson', () => {
  it('collapses a short primitive array onto one line', () => {
    expect(formatBiomeJson({ required: ['url'] })).toBe('{\n  "required": ["url"]\n}');
    expect(formatBiomeJson({ required: ['email', 'password', 'consoleUrl'] })).toBe(
      '{\n  "required": ["email", "password", "consoleUrl"]\n}',
    );
  });

  it('expands an array whose flat form exceeds the line width', () => {
    const long = Array.from({ length: 20 }, (_, i) => `item_number_${i}`);
    const out = formatBiomeJson({ items: long });
    expect(out).toContain('"items": [\n'); // broke onto multiple lines
    expect(out).toContain('    "item_number_0"');
  });

  it('expands arrays that contain objects (objects never collapse)', () => {
    const out = formatBiomeJson({ tools: [{ name: 'a' }] });
    expect(out).toBe('{\n  "tools": [\n    {\n      "name": "a"\n    }\n  ]\n}');
  });

  it('always expands non-empty objects but inlines empty array/object', () => {
    expect(formatBiomeJson({ a: 1, b: 2 })).toBe('{\n  "a": 1,\n  "b": 2\n}');
    expect(formatBiomeJson({ params: {} })).toBe('{\n  "params": {}\n}');
    expect(formatBiomeJson({ list: [] })).toBe('{\n  "list": []\n}');
  });

  it('round-trips: parsed output equals the input value', () => {
    const value = { v: 1, tools: [{ name: 'x', tags: ['a', 'b'] }], features: { chat: { modes: ['m'] } } };
    expect(JSON.parse(formatBiomeJson(value))).toEqual(value);
  });
});
