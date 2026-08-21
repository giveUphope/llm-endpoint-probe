import { describe, expect, it } from 'vitest';
import { buildPreview, isPreviewNode, PREVIEW_MAX_ENTRIES, PREVIEW_MAX_ITEMS } from './preview';

describe('response preview digest', () => {
  it('keeps short strings inline and digests long text with head/tail samples', () => {
    expect(buildPreview('hello')).toEqual({ kind: 'scalar', value: 'hello' });

    const long = `${'x'.repeat(3000)}\nsecond-line`;
    const node = buildPreview(long) as { kind: 'text'; length: number; lines: number; head: string; tail: string };
    expect(node.kind).toBe('text');
    expect(node.length).toBe(3012);
    expect(node.lines).toBe(2);
    expect(node.head).toBe('x'.repeat(2000));
    expect(node.tail.endsWith('second-line')).toBe(true);
    expect(node.head.length + node.tail.length).toBeLessThan(3000);
  });

  it('caps arrays and objects while preserving the real totals', () => {
    const many = Array.from({ length: 500 }, (_, index) => index);
    const array = buildPreview(many) as { kind: 'array'; length: number; shown: number };
    expect(array).toMatchObject({ kind: 'array', length: 500, shown: PREVIEW_MAX_ITEMS });

    const object = buildPreview(Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`k${index}`, index]))) as { kind: 'object'; length: number; shown: number };
    expect(object).toMatchObject({ kind: 'object', length: 100, shown: PREVIEW_MAX_ENTRIES });
  });

  it('masks sensitive field values by name without depending on caller secrets', () => {
    const node = buildPreview({ apiKey: 'sk-live', data: { refresh_token: 'abc' }, message: 'ok' }) as { kind: 'object'; entries: Array<{ key: string; node: unknown }> };
    const byKey = (key: string) => node.entries.find((entry) => entry.key === key)?.node;
    expect(byKey('apiKey')).toEqual({ kind: 'scalar', value: '[REDACTED]' });
    expect(byKey('message')).toEqual({ kind: 'scalar', value: 'ok' });
  });

  it('stops descending past the depth limit and reports it as truncated', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } };
    const node = buildPreview(deep, { maxDepth: 3 }) as { kind: 'object'; entries: Array<{ node: unknown }> };
    let current: unknown = node;
    for (let level = 0; level < 4; level += 1) {
      current = (current as { entries: Array<{ node: unknown }> }).entries[0].node;
    }
    expect(current).toEqual({ kind: 'truncated', reason: 'depth' });
  });

  it('enforces the global node budget and keeps earlier nodes intact', () => {
    const wide = Array.from({ length: 50 }, (_, index) => ({ id: index, nested: { value: index } }));
    const node = buildPreview(wide, { maxNodes: 10 }) as { kind: 'array'; shown: number; length: number };
    expect(node.shown).toBeLessThan(50);
    expect(node.shown).toBeGreaterThan(0);
  });

  it('passes scalars through and recognizes digest nodes', () => {
    expect(buildPreview(null)).toEqual({ kind: 'scalar', value: null });
    expect(buildPreview(42)).toEqual({ kind: 'scalar', value: 42 });
    expect(buildPreview(true)).toEqual({ kind: 'scalar', value: true });
    expect(isPreviewNode(buildPreview({ a: [1, 2, 3] }))).toBe(true);
    expect(isPreviewNode({ plain: 'object' })).toBe(false);
  });
});
