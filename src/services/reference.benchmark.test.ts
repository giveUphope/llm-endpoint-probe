import { describe, expect, it } from 'vitest';
import { PARAMETER_CAPABILITIES } from '../adapters/shared';
import { capabilityKeys, emptyCapabilities } from '../domain/capabilities';
import type { CapabilityKey, CapabilityStatus, DiscoveredModel, ReferenceCatalog, ReferenceModelEntry } from '../domain/types';
import sample from './reference.catalog.sample.json';
import {
  compareReference,
  matchReference,
  parseReferenceCatalog,
  type ReferenceComparison,
} from './reference';

// 真实 OpenRouter 目录的脱敏样本（档位上架、别名条目、多 provider 分组全覆盖），
// 用来锁住参照匹配的两类回归：写法差异造成的漏匹配、以及参照侧造出的假冲突
const catalog = parseReferenceCatalog(sample, sample.url, sample.fetchedAt) as ReferenceCatalog;

function probeModel(id: string, overrides: Partial<DiscoveredModel> = {}): DiscoveredModel {
  return {
    id,
    displayName: id,
    protocol: 'openai-chat',
    inputModalities: ['text'],
    capabilities: emptyCapabilities(),
    reasoningLevels: [],
    supportedEndpoints: ['/chat/completions'],
    discoverySource: 'test',
    confidence: 'unknown',
    status: 'discovered',
    lastProbedAt: '2026-09-30T00:00:00.000Z',
    rawMetadata: {},
    ...overrides,
  };
}

// 端点侧常见的真实写法变形：去 provider、下划线分隔、全大写、Ollama 量化 tag 后缀
function endpointSpellings(id: string): string[] {
  const tail = id.replace(/^~?(?:[^/]+\/)+/, '');
  const base = tail.replace(/:.*$/, '');
  return [tail, tail.replace(/-/g, '_'), tail.toUpperCase(), `${base}:q4_K_M`, `${base}:latest`];
}

// 端点结论完全照抄参照声明时的模型：这种端点不该被判出任何冲突
function mirroringModel(entry: ReferenceModelEntry): DiscoveredModel {
  const capabilities = emptyCapabilities();
  for (const key of capabilityKeys as CapabilityKey[]) {
    const declared = catalogDeclaration(entry, key);
    const status: CapabilityStatus = {
      value: declared === null ? 'unknown' : declared ? 'supported' : 'unsupported',
      evidence: [{ source: 'endpoint', confidence: 'medium', detail: '目录声明', timestamp: '2026-09-30T00:00:00.000Z' }],
    };
    capabilities[key] = status;
  }
  return probeModel(entry.id, {
    capabilities,
    ...(entry.contextWindow != null ? { contextWindow: entry.contextWindow } : {}),
    inputModalities: entry.inputModalities,
    reasoningLevels: entry.reasoningLevels,
  });
}

// 该能力在参照条目里是否声明支持；流式与缓存不属于参照覆盖范围
function catalogDeclaration(entry: ReferenceModelEntry, key: CapabilityKey): boolean | null {
  if (key === 'supportsStreaming' || key === 'supportsPromptCache') return null;
  if (key === 'supportsReasoning' && entry.reasoningLevels.length > 0) return true;
  if (!entry.supportedParameters) return null;
  return entry.supportedParameters.some((parameter) => PARAMETER_CAPABILITIES[key].includes(parameter));
}

describe('reference catalog benchmark', () => {
  it('parses the sampled live directory', () => {
    expect(catalog.models.length).toBeGreaterThan(150);
    expect(catalog.models.filter((entry) => entry.tier).length).toBeGreaterThan(50);
    expect(catalog.models.filter((entry) => entry.alias).length).toBeGreaterThan(5);
  });

  it('matches every catalog id back to itself', () => {
    const misses = catalog.models.filter((entry) => {
      const match = matchReference(probeModel(entry.id), catalog);
      return !match || !match.variants.some((variant) => variant.id === entry.id);
    });
    expect(misses.map((entry) => entry.id)).toEqual([]);
  });

  it('matches realistic endpoint spellings of the same model', () => {
    const failures: string[] = [];
    for (const entry of catalog.models) {
      for (const spelling of endpointSpellings(entry.id)) {
        const match = matchReference(probeModel(spelling), catalog);
        if (!match || !match.variants.some((variant) => variant.id === entry.id)) failures.push(`${spelling} ≠ ${entry.id}`);
      }
    }
    // 写法差异绝不允许造成漏匹配；命中集合必须仍然包含原条目本身
    expect(failures).toEqual([]);
  });

  it('reuses the built index across lookups instead of rescanning the directory', () => {
    // 详情面板每次渲染都要查一次参照；没有索引时这里会退化成 目录规模 × 查询数 的扫描
    const started = performance.now();
    for (let round = 0; round < 3; round += 1) {
      for (const entry of catalog.models) matchReference(probeModel(entry.id), catalog);
    }
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(3000);
  });

  it('never reports a conflict against an endpoint that mirrors the reference declarations', () => {
    const offenders: Array<{ id: string; comparison: ReferenceComparison }> = [];
    for (const entry of catalog.models) {
      const match = matchReference(probeModel(entry.id), catalog);
      if (!match) continue;
      const comparison = compareReference(mirroringModel(entry), match);
      if (comparison.conflictCount || comparison.contextConflict || comparison.modalityConflict) {
        offenders.push({ id: entry.id, comparison });
      }
    }
    expect(offenders.map((offender) => `${offender.id}: ${offender.comparison.conflictCount} 冲突`)).toEqual([]);
  });

  it('merges tier listings instead of narrowing the reference to one listing', () => {
    const batched = catalog.models.filter((entry) => entry.tier === 'batch');
    const widened: string[] = [];
    for (const entry of batched) {
      const match = matchReference(probeModel(entry.id), catalog);
      if (!match || match.variants.length < 2) continue;
      const declared = new Set(match.variants.flatMap((variant) => variant.supportedParameters ?? []));
      const own = new Set(entry.supportedParameters ?? []);
      if (declared.size > own.size) widened.push(entry.id);
    }
    // 窄档位单独拿出来比会造出假“不支持”，合并后声明面必须更宽
    expect(widened.length).toBeGreaterThan(10);
  });

  it('resolves alias listings to their target declarations', () => {
    const alias = catalog.models.find((entry) => entry.alias && entry.aliasTarget);
    expect(alias).toBeDefined();
    const match = matchReference(probeModel(alias!.id), catalog);
    expect(match?.variants.some((variant) => variant.id === alias!.id)).toBe(true);
    // 别名条目自带声明时不必跟进；没有声明时必须并进来真实条目的声明
    const expectsTarget = alias!.supportedParameters === undefined;
    expect(match?.variants.some((variant) => variant.id === alias!.aliasTarget)).toBe(expectsTarget);
  });
});
