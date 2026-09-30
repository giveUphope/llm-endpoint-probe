import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyCapabilities } from '../domain/capabilities';
import type { CapabilityKey, CapabilityStatus, CapabilityValue, DiscoveredModel, ReferenceCatalog, ReferenceModelEntry } from '../domain/types';
import { createProfile } from '../lib/profile';
import {
  compareReference,
  fetchReferenceCatalog,
  matchReference,
  normalizeReferenceId,
  parseReferenceCatalog,
} from './reference';

function model(overrides: Partial<DiscoveredModel> = {}): DiscoveredModel {
  return {
    id: 'my-fake-model',
    displayName: 'Fake Model',
    protocol: 'openai-chat',
    inputModalities: ['text'],
    capabilities: emptyCapabilities(),
    reasoningLevels: [],
    supportedEndpoints: ['/chat/completions'],
    discoverySource: 'test',
    confidence: 'unknown',
    status: 'discovered',
    lastProbedAt: new Date().toISOString(),
    rawMetadata: {},
    ...overrides,
  };
}

function catalogOf(models: ReferenceModelEntry[]): ReferenceCatalog {
  return { source: 'openrouter', url: 'https://openrouter.ai/api/v1/models', fetchedAt: '2026-09-30T00:00:00.000Z', models };
}

describe('reference catalog parsing', () => {
  afterEach(() => vi.restoreAllMocks());

  it('normalizes OpenRouter ids by stripping aliases, tiers, and provider prefixes', () => {
    expect(normalizeReferenceId('~openai/gpt-4o:free')).toBe('openai/gpt-4o');
    expect(normalizeReferenceId('openai/gpt-4o:batch')).toBe('openai/gpt-4o');
    expect(normalizeReferenceId('GPT-4o')).toBe('gpt-4o');
  });

  it('parses entries into typed reference rows and skips malformed items', () => {
    const catalog = parseReferenceCatalog({
      data: [
        {
          id: 'openai/gpt-4o',
          name: 'OpenAI: GPT-4o',
          context_length: 128000,
          architecture: { input_modalities: ['text', 'image', 'file'] },
          supported_parameters: ['Tools', 'temperature', 'stream'],
          reasoning: { supported_efforts: ['low', 'high'] },
        },
        { id: '' },
        'not-an-object',
      ],
    }, 'https://openrouter.ai/api/v1/models', '2026-09-30T00:00:00.000Z');

    expect(catalog.models).toHaveLength(1);
    expect(catalog.models[0]).toEqual({
      id: 'openai/gpt-4o',
      name: 'OpenAI: GPT-4o',
      contextWindow: 128000,
      inputModalities: ['text', 'image', 'pdf'],
      supportedParameters: ['tools', 'temperature', 'stream'],
      reasoningLevels: ['low', 'high'],
    });
  });

  it('keeps streaming and prompt cache uncovered by the reference directory', () => {
    const catalog = parseReferenceCatalog({
      data: [{ id: 'x/y', supported_parameters: ['stream', 'cache_control', 'tools'], architecture: { input_modalities: ['text'] } }],
    }, 'url', 'now');
    const comparison = compareReference(model(), catalog.models[0]);
    const byKey = Object.fromEntries(comparison.rows.map((row) => [row.key, row]));
    expect(byKey.supportsStreaming.reference).toBe('unknown');
    expect(byKey.supportsPromptCache.reference).toBe('unknown');
    expect(byKey.supportsTools.reference).toBe('supported');
    expect(byKey.supportsSeed.reference).toBe('unsupported');
    expect(byKey.supportsSeed.conflict).toBe(false);
  });

  it('raises a format error when the payload has no data array or no usable entries', () => {
    expect(() => parseReferenceCatalog({}, 'url', 'now')).toThrowError(/data 数组/);
    expect(() => parseReferenceCatalog({ data: [{ id: '' }] }, 'url', 'now')).toThrowError(/没有可用条目/);
  });

  it('accepts both the flat proxy envelope and the upstream-nested envelope', () => {
    // 代理返回扁平条目数组，上游原始响应是 { data: { data: [...] } }：
    // 两种形状都必须能解析，否则接上真实代理就会整块参照不可用
    const flat = parseReferenceCatalog({ data: [{ id: 'x/y' }] }, 'url', 'now');
    const nested = parseReferenceCatalog({ data: { data: [{ id: 'x/y' }] } }, 'url', 'now');
    expect(flat.models.map((entry) => entry.id)).toEqual(['x/y']);
    expect(nested.models.map((entry) => entry.id)).toEqual(['x/y']);
  });
});

describe('reference matching and comparison', () => {
  it('matches prefixed, suffixed, and versioned ids by normalized name words', () => {
    const catalog = catalogOf([
      { id: 'deepseek/deepseek-chat-v3:free', inputModalities: ['text'], supportedParameters: [], reasoningLevels: [] },
      { id: 'meta-llama/llama-3.3-70b-instruct', inputModalities: ['text'], supportedParameters: [], reasoningLevels: [] },
    ]);
    expect(matchReference(model({ id: 'qwen2.5-coder-7b' }), catalog)).toBeUndefined();
    expect(matchReference(model({ id: 'deepseek-chat-v3' }), catalog)?.entry.id).toBe('deepseek/deepseek-chat-v3:free');
    expect(matchReference(model({ id: 'llama-3.3-70b-instruct' }), catalog)?.entry.id).toBe('meta-llama/llama-3.3-70b-instruct');
    expect(matchReference(model({ id: 'unrelated-model' }), catalog)).toBeUndefined();
  });

  it('flags conflicts only when both sides are definitive and disagree', () => {
    const local = model();
    local.capabilities.supportsTools = {
      value: 'supported',
      evidence: [{ source: 'validated', confidence: 'high', detail: '实测到 tool_calls', timestamp: '2026-09-30T00:00:00.000Z' }],
    };
    local.capabilities.supportsSeed = {
      value: 'unsupported',
      evidence: [{ source: 'endpoint', confidence: 'medium', detail: '目录未声明', timestamp: '2026-09-30T00:00:00.000Z' }],
    };
    const entry: ReferenceModelEntry = { id: 'x/y', inputModalities: ['text'], supportedParameters: ['temperature'], reasoningLevels: [] };
    const comparison = compareReference(local, entry);
    const byKey = Object.fromEntries(comparison.rows.map((row) => [row.key, row]));
    expect(byKey.supportsTools).toMatchObject({ local: 'supported', reference: 'unsupported', conflict: true });
    expect(byKey.supportsSeed).toMatchObject({ local: 'unsupported', reference: 'unsupported', conflict: false });
    expect(byKey.supportsTemperature).toMatchObject({ local: 'unknown', reference: 'supported', conflict: false });
    expect(comparison.conflictCount).toBe(1);
  });

  it('compares context window and input modalities with uncovered handling', () => {
    const entry: ReferenceModelEntry = { id: 'x/y', contextWindow: 128000, inputModalities: ['text', 'image'], supportedParameters: [], reasoningLevels: [] };
    // 参照声明的模态更广只作提示：端点目录没列出 image 不等于端点不支持
    const wider = compareReference(model({ contextWindow: 16000, inputModalities: ['text'] }), entry);
    expect(wider.contextConflict).toBe(true);
    expect(wider.modalityConflict).toBe(false);
    expect(wider.referenceOnlyModalities).toEqual(['image']);
    expect(wider.conflictCount).toBe(0);

    // 端点声明了参照没有的模态才算冲突
    const narrower = compareReference(model({ contextWindow: 16000, inputModalities: ['text', 'video'] }), entry);
    expect(narrower.modalityConflict).toBe(true);

    const uncovered = compareReference(model({ contextWindow: 16000, inputModalities: ['text'] }), { id: 'x/y', inputModalities: ['text'], reasoningLevels: [] });
    expect(uncovered.contextConflict).toBe(false);
    expect(uncovered.modalityConflict).toBe(false);
  });
});

describe('reference tier and ambiguity handling', () => {
  function entryOf(id: string, overrides: Partial<ReferenceModelEntry> = {}): ReferenceModelEntry {
    return { id, inputModalities: ['text'], supportedParameters: [], reasoningLevels: [], ...overrides };
  }
  function local(key: CapabilityKey, value: CapabilityValue, overrides: Partial<DiscoveredModel> = {}): DiscoveredModel {
    const discovered = model(overrides);
    const status: CapabilityStatus = {
      value,
      evidence: [{ source: 'validated', confidence: 'high', detail: '实测结论', timestamp: '2026-09-30T00:00:00.000Z' }],
    };
    discovered.capabilities[key] = status;
    return discovered;
  }

  it('keeps canonical slug and tier suffix when parsing catalog entries', () => {
    const catalog = parseReferenceCatalog({
      data: [
        { id: 'qwen/qwen3.8-27b:free', canonical_slug: 'qwen/qwen3.8-27b', context_length: 262144, architecture: { input_modalities: ['text'] }, supported_parameters: ['temperature'] },
        { id: 'qwen/qwen3.8-27b', canonical_slug: 'qwen/qwen3.8-27b', context_length: 1000000, architecture: { input_modalities: ['text'] }, supported_parameters: ['temperature', 'tools'] },
      ],
    }, 'url', 'now');
    expect(catalog.models.map((entry) => entry.tier)).toEqual(['free', undefined]);
    expect(catalog.models.map((entry) => entry.canonicalSlug)).toEqual(['qwen/qwen3.8-27b', 'qwen/qwen3.8-27b']);
  });

  it('prefers the primary listing over a tier variant that declares a smaller context window', () => {
    // 真实目录里 :free 档常声明更小的 context_length，命中它会造出假的上下文冲突
    const catalog = catalogOf([
      entryOf('qwen/qwen3.8-27b:free', { canonicalSlug: 'qwen/qwen3.8-27b', tier: 'free', contextWindow: 262144 }),
      entryOf('qwen/qwen3.8-27b', { canonicalSlug: 'qwen/qwen3.8-27b', contextWindow: 1000000 }),
    ]);
    const discovered = model({ id: 'qwen3.8-27b', contextWindow: 1000000 });
    const match = matchReference(discovered, catalog);
    expect(match?.entry.id).toBe('qwen/qwen3.8-27b');
    expect(match?.variants.map((variant) => variant.id)).toEqual(['qwen/qwen3.8-27b', 'qwen/qwen3.8-27b:free']);
    expect(compareReference(discovered, match!).contextConflict).toBe(false);
  });

  it('merges tier declarations so a narrower batch tier cannot fake a capability conflict', () => {
    // 真实目录里 :batch 档声明的 supported_parameters 集合小于主档
    const catalog = catalogOf([
      entryOf('openai/gpt-6.1-sol:batch', { canonicalSlug: 'openai/gpt-6.1-sol', tier: 'batch', supportedParameters: ['tools', 'temperature'] }),
      entryOf('openai/gpt-6.1-sol', { canonicalSlug: 'openai/gpt-6.1-sol', supportedParameters: ['temperature', 'seed'] }),
    ]);
    const discovered = local('supportsSeed', 'supported', { id: 'gpt-6.1-sol' });
    const comparison = compareReference(discovered, matchReference(discovered, catalog)!);
    expect(comparison.rows.find((row) => row.key === 'supportsTools')).toMatchObject({ local: 'unknown', reference: 'supported' });
    expect(comparison.rows.find((row) => row.key === 'supportsSeed')?.reference).toBe('supported');
    expect(comparison.conflictCount).toBe(0);
  });

  it('counts a context window that matches any tier as consistent', () => {
    const catalog = catalogOf([
      entryOf('qwen/qwen3.8-27b', { canonicalSlug: 'qwen/qwen3.8-27b', contextWindow: 1000000 }),
      entryOf('qwen/qwen3.8-27b:free', { canonicalSlug: 'qwen/qwen3.8-27b', tier: 'free', contextWindow: 262144 }),
    ]);
    const discovered = model({ id: 'qwen3.8-27b', contextWindow: 262144 });
    const comparison = compareReference(discovered, matchReference(discovered, catalog)!);
    expect(comparison.contextConflict).toBe(false);
    expect(comparison.contextTiers).toEqual([1000000, 262144]);
  });

  it('still matches when the directory only lists a tier variant', () => {
    const catalog = catalogOf([entryOf('openai/gpt-5.2:batch', { canonicalSlug: 'openai/gpt-5.2', tier: 'batch' })]);
    const match = matchReference(model({ id: 'gpt-5.2' }), catalog);
    expect(match?.entry.id).toBe('openai/gpt-5.2:batch');
    expect(match?.ambiguous).toBe(false);
  });

  it('merges same-name listings from different providers and only reports unsupported when all of them omit it', () => {
    // 端点只回名字时，同名型号可能有多个 provider 上架：合并取并集，
    // “不支持”必须所有声明过参数的条目都没列出来才成立
    const catalog = catalogOf([
      entryOf('openai/gpt-4o', { canonicalSlug: 'openai/gpt-4o', supportedParameters: ['temperature'] }),
      entryOf('thirdparty-relay/gpt-4o', { canonicalSlug: 'thirdparty-relay/gpt-4o', supportedParameters: [] }),
    ]);
    const discovered = local('supportsTools', 'supported', { id: 'gpt-4o' });
    const match = matchReference(discovered, catalog);
    expect(match?.ambiguous).toBe(false);
    expect(match?.providerCount).toBe(2);
    const comparison = compareReference(discovered, match!);
    expect(comparison.rows.find((row) => row.key === 'supportsTools')).toMatchObject({
      reference: 'unsupported',
      conflict: true,
      severity: 'validated-over-declaration',
    });
    expect(comparison.validatedConflicts).toBe(1);
    expect(comparison.declaredConflicts).toBe(0);
  });

  it('will not overturn an endpoint unsupported verdict from a partial reference declaration', () => {
    // 只有一个 provider 的上架条目声明支持 tools：不足以判端点“不支持”为冲突
    const catalog = catalogOf([
      entryOf('openai/gpt-4o', { canonicalSlug: 'openai/gpt-4o', supportedParameters: ['tools', 'temperature'] }),
      entryOf('relay-mirror/gpt-4o', { canonicalSlug: 'relay-mirror/gpt-4o', supportedParameters: ['temperature'] }),
    ]);
    const discovered = local('supportsTools', 'unsupported', { id: 'gpt-4o' });
    const comparison = compareReference(discovered, matchReference(discovered, catalog)!);
    const tools = comparison.rows.find((row) => row.key === 'supportsTools');
    expect(tools).toMatchObject({ reference: 'supported', partial: true, supportingListings: 1, conflict: false });
    expect(comparison.conflictCount).toBe(0);
  });

  it('suppresses conclusions when only a provider prefix could explain the word difference', () => {
    // 词集合本身不一致、只能靠 provider 前缀解释差集，且有两个这种条目：不判冲突
    const catalog = catalogOf([
      entryOf('meta-llama/llama-3.1-8b', { canonicalSlug: 'meta-llama/llama-3.1-8b', supportedParameters: [] }),
      entryOf('meta-cloud/llama-3.1-8b', { canonicalSlug: 'meta-cloud/llama-3.1-8b', supportedParameters: ['tools'] }),
    ]);
    const discovered = local('supportsTools', 'unsupported', { id: 'Meta-Llama-3.1-8B' });
    const match = matchReference(discovered, catalog);
    expect(match?.ambiguous).toBe(true);
    expect(match?.otherGroups.length).toBe(1);
    expect(compareReference(discovered, match!).conflictCount).toBe(0);
  });

  it('does not treat dated version listings as an ambiguous match for the base name', () => {
    // 真实目录里 openai/gpt-4o 与 openai/gpt-4o-2024-05-13 并存：日期折叠成同一条参照，
    // 不能让它变成"匹配到多个条目"的歧义从而掩盖真正的精确匹配
    const catalog = catalogOf([
      entryOf('openai/gpt-4o-2024-05-13', { canonicalSlug: 'openai/gpt-4o-2024-05-13', supportedParameters: ['temperature'] }),
      entryOf('openai/gpt-4o', { canonicalSlug: 'openai/gpt-4o', supportedParameters: ['tools', 'temperature'] }),
    ]);
    const discovered = local('supportsTools', 'supported', { id: 'gpt-4o' });
    const match = matchReference(discovered, catalog);
    expect(match?.entry.id).toBe('openai/gpt-4o');
    expect(match?.ambiguous).toBe(false);
    expect(compareReference(discovered, match!).conflictCount).toBe(0);
  });
});

describe('reference name normalization and recall', () => {
  function entryOf(id: string, overrides: Partial<ReferenceModelEntry> = {}): ReferenceModelEntry {
    return { id, inputModalities: ['text'], supportedParameters: [], reasoningLevels: [], ...overrides };
  }
  const catalog = catalogOf([
    entryOf('meta-llama/llama-3.1-8b-instruct', { canonicalSlug: 'meta-llama/llama-3.1-8b', contextWindow: 128000, supportedParameters: ['tools', 'temperature'] }),
    entryOf('meta-llama/llama-3.1-70b-instruct', { canonicalSlug: 'meta-llama/llama-3.1-70b', supportedParameters: ['tools'] }),
    entryOf('qwen/qwen-2.5-coder-7b-instruct', { canonicalSlug: 'qwen/qwen-2.5-coder-7b', supportedParameters: ['tools'] }),
    entryOf('google/gemini-2.5-flash', { canonicalSlug: 'google/gemini-2.5-flash', supportedParameters: ['tools'] }),
    entryOf('~google/gemini-flash-latest', { canonicalSlug: '~google/gemini-flash-latest', alias: true, aliasTarget: 'google/gemini-2.5-flash', supportedParameters: undefined }),
    entryOf('openai/gpt-4o', { canonicalSlug: 'openai/gpt-4o', supportedParameters: ['tools'] }),
    entryOf('openai/gpt-4o-2024-11-20', { canonicalSlug: 'openai/gpt-4o-2024-11-20', supportedParameters: ['temperature'] }),
    entryOf('deepseek/deepseek-chat-v3.1', { canonicalSlug: 'deepseek/deepseek-chat-v3.1', supportedParameters: [] }),
  ]);
  const matchedId = (id: string) => matchReference(model({ id }), catalog)?.entry.id;

  it('resolves the endpoint id spellings that previously slipped through', () => {
    expect(matchedId('llama3.1:8b')).toBe('meta-llama/llama-3.1-8b-instruct');
    expect(matchedId('Meta-Llama-3.1-8B')).toBe('meta-llama/llama-3.1-8b-instruct');
    expect(matchedId('Meta-Llama-3.1-8B-Instruct')).toBe('meta-llama/llama-3.1-8b-instruct');
    expect(matchedId('llama-3.1-8b-instruct-q4-K-M')).toBe('meta-llama/llama-3.1-8b-instruct');
    expect(matchedId('Qwen2.5-Coder-7B-Instruct')).toBe('qwen/qwen-2.5-coder-7b-instruct');
    expect(matchedId('gemini 2.5 flash')).toBe('google/gemini-2.5-flash');
    expect(matchedId('gpt-4o')).toBe('openai/gpt-4o');
  });

  it('keeps size and sub-model words distinguishing instead of fuzzy-matching', () => {
    expect(matchedId('llama3.1:70b')).toBe('meta-llama/llama-3.1-70b-instruct');
    expect(matchReference(model({ id: 'llama3.1:8b' }), catalog)?.variants.map((variant) => variant.id))
      .toEqual(['meta-llama/llama-3.1-8b-instruct']);
    expect(matchReference(model({ id: 'gpt-4o-mini' }), catalog)).toBeUndefined();
    expect(matchReference(model({ id: 'gpt-4' }), catalog)).toBeUndefined();
    expect(matchReference(model({ id: 'qwen2.5-vl-7b' }), catalog)).toBeUndefined();
  });

  it('treats dated listings as the same model rather than a competing match', () => {
    const match = matchReference(model({ id: 'gpt-4o' }), catalog);
    expect(match?.ambiguous).toBe(false);
    expect(match?.variants.map((variant) => variant.id))
      .toEqual(['openai/gpt-4o', 'openai/gpt-4o-2024-11-20']);
  });

  it('follows an alias listing that carries no declarations of its own', () => {
    const discovered = model({ id: 'gemini-flash-latest' });
    const match = matchReference(discovered, catalog);
    // 跟进真实条目后，展示代表取声明更完整的那一条
    expect(match?.entry.id).toBe('google/gemini-2.5-flash');
    expect(match?.variants.map((variant) => variant.id)).toContain('~google/gemini-flash-latest');
    expect(match?.variants.some((variant) => variant.aliasTarget === 'google/gemini-2.5-flash')).toBe(true);
    const comparison = compareReference(discovered, match!);
    expect(comparison.rows.find((row) => row.key === 'supportsTools')?.reference).toBe('supported');
  });

  it('compares reasoning effort levels and counts them as reasoning coverage', () => {
    const withEfforts = catalogOf([entryOf('x/y', {
      supportedParameters: undefined,
      reasoningLevels: ['low', 'medium', 'high'],
    })]);
    const discovered = model({ id: 'y', reasoningLevels: ['low', 'high'] });
    const comparison = compareReference(discovered, matchReference(discovered, withEfforts)!);
    expect(comparison.rows.find((row) => row.key === 'supportsReasoning')?.reference).toBe('supported');
    expect(comparison.reasoning).toMatchObject({ covered: true, localOnly: [], referenceOnly: ['medium'] });
  });
});

describe('reference catalog transport', () => {
  afterEach(() => vi.restoreAllMocks());

  it('fetches through the local read-only route with same-origin credentials', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      url: 'https://openrouter.ai/api/v1/models',
      fetchedAt: '2026-09-30T00:00:00.000Z',
      data: [{ id: 'openai/gpt-4o' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const catalog = await fetchReferenceCatalog();
    expect(catalog.models.map((entry) => entry.id)).toEqual(['openai/gpt-4o']);
    expect(fetchMock).toHaveBeenCalledWith('/api/reference/models', expect.objectContaining({ cache: 'no-store', credentials: 'same-origin' }));
    // 参照拉取必须是纯只读：不携带任何端点配置、令牌或 API Key
    const [, init] = fetchMock.mock.calls[0];
    expect(String(init?.body ?? '')).toBe('');
  });

  it('degrades to an actionable ProbeError instead of throwing raw failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: '参照目录上游返回 HTTP 500' }), { status: 502, headers: { 'Content-Type': 'application/json' } }));
    await expect(fetchReferenceCatalog()).rejects.toMatchObject({ type: 'network', message: '参照目录上游返回 HTTP 500' });

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('connection refused'));
    await expect(fetchReferenceCatalog()).rejects.toMatchObject({ type: 'network', message: '参照目录获取失败：本地受控代理不可达' });
  });

  it('carries the degraded snapshot markers through to the catalog', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      url: 'https://openrouter.ai/api/v1/models',
      fetchedAt: '2026-09-30T00:00:00.000Z',
      stale: true,
      staleReason: '参照目录上游返回 HTTP 500',
      data: [{ id: 'openai/gpt-4o' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const catalog = await fetchReferenceCatalog();
    expect(catalog).toMatchObject({ stale: true, staleReason: '参照目录上游返回 HTTP 500', fetchedAt: '2026-09-30T00:00:00.000Z' });
    expect(catalog.models.map((entry) => entry.id)).toEqual(['openai/gpt-4o']);
  });
});
