import { SENSITIVE_KEY } from './security';

// 响应预览结构化摘要：后端 /api/proxy 与前端共用。
// 把任意上游响应转成有界、可逐项人工分析的树：长文本只保留首尾样本，
// 数组/对象记录总数并只展开前若干项，任何节点都携带可展示的类型与体量信息。

export const PREVIEW_SHORT_STRING = 200;
export const PREVIEW_STRING_SAMPLE = 1_200;
export const PREVIEW_STRING_TAIL = 400;
export const PREVIEW_MAX_ENTRIES = 40;
export const PREVIEW_MAX_ITEMS = 40;
export const PREVIEW_MAX_DEPTH = 6;
export const PREVIEW_MAX_NODES = 800;

export interface PreviewScalar {
  kind: 'scalar';
  value: string | number | boolean | null;
}

export interface PreviewText {
  kind: 'text';
  length: number;
  lines: number;
  head: string;
  tail: string;
}

export interface PreviewArray {
  kind: 'array';
  length: number;
  shown: number;
  items: PreviewNode[];
}

export interface PreviewObject {
  kind: 'object';
  length: number;
  shown: number;
  entries: Array<{ key: string; node: PreviewNode }>;
}

export interface PreviewTruncated {
  kind: 'truncated';
  reason: 'depth' | 'budget';
}

export type PreviewNode = PreviewScalar | PreviewText | PreviewArray | PreviewObject | PreviewTruncated;

export interface PreviewOptions {
  shortStringLimit?: number;
  stringSample?: number;
  stringTail?: number;
  maxEntries?: number;
  maxItems?: number;
  maxDepth?: number;
  maxNodes?: number;
}

export function isPreviewNode(value: unknown): value is PreviewNode {
  if (!value || typeof value !== 'object') return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === 'scalar' || kind === 'text' || kind === 'array' || kind === 'object' || kind === 'truncated';
}

export function buildPreview(data: unknown, options: PreviewOptions = {}): PreviewNode {
  const budget = { nodes: options.maxNodes ?? PREVIEW_MAX_NODES };
  return buildNode(data, 0, options, budget);
}

function buildNode(value: unknown, depth: number, options: PreviewOptions, budget: { nodes: number }): PreviewNode {
  if (depth > (options.maxDepth ?? PREVIEW_MAX_DEPTH)) return { kind: 'truncated', reason: 'depth' };
  if (typeof value === 'string') {
    // 短字符串作为行内标量展示；只有长文本才进入文本卡片并截断
    return value.length <= (options.shortStringLimit ?? PREVIEW_SHORT_STRING) ? { kind: 'scalar', value } : buildText(value, options);
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return { kind: 'scalar', value };
  if (Array.isArray(value)) {
    const maxItems = options.maxItems ?? PREVIEW_MAX_ITEMS;
    const items: PreviewNode[] = [];
    for (const item of value) {
      if (items.length >= maxItems || budget.nodes <= 0) break;
      budget.nodes -= 1;
      items.push(buildNode(item, depth + 1, options, budget));
    }
    return { kind: 'array', length: value.length, shown: items.length, items };
  }
  if (value && typeof value === 'object') {
    const maxEntries = options.maxEntries ?? PREVIEW_MAX_ENTRIES;
    const entries: Array<{ key: string; node: PreviewNode }> = [];
    for (const [key, item] of Object.entries(value)) {
      if (entries.length >= maxEntries || budget.nodes <= 0) break;
      budget.nodes -= 1;
      // 与脱敏规则保持一致：敏感字段名一律不展示其值
      entries.push({ key, node: SENSITIVE_KEY.test(key) ? { kind: 'scalar', value: '[REDACTED]' } : buildNode(item, depth + 1, options, budget) });
    }
    return { kind: 'object', length: Object.keys(value).length, shown: entries.length, entries };
  }
  return { kind: 'scalar', value: null };
}

function buildText(value: string, options: PreviewOptions): PreviewText {
  const sample = options.stringSample ?? PREVIEW_STRING_SAMPLE;
  const tail = options.stringTail ?? PREVIEW_STRING_TAIL;
  const length = value.length;
  const lines = length ? value.split('\n').length : 0;
  if (length <= sample + tail) return { kind: 'text', length, lines, head: value, tail: '' };
  return { kind: 'text', length, lines, head: value.slice(0, sample), tail: value.slice(-tail) };
}
