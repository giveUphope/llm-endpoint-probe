import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyCapabilities } from '../domain/capabilities';
import type { DiscoveredModel, ReferenceCatalog, ReferenceModelEntry } from '../domain/types';
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
});

describe('reference matching and comparison', () => {
  it('matches prefixed, suffixed, and versioned ids through sameModelName', () => {
    const catalog = catalogOf([
      { id: 'deepseek/deepseek-chat-v3:free', inputModalities: ['text'], supportedParameters: [], reasoningLevels: [] },
      { id: 'meta-llama/llama-3.3-70b-instruct', inputModalities: ['text'], supportedParameters: [], reasoningLevels: [] },
    ]);
    expect(matchReference(model({ id: 'qwen2.5-coder-7b' }), catalog)).toBeUndefined();
    expect(matchReference(model({ id: 'deepseek-chat-v3' }), catalog)?.id).toBe('deepseek/deepseek-chat-v3:free');
    expect(matchReference(model({ id: 'llama-3.3-70b-instruct' }), catalog)?.id).toBe('meta-llama/llama-3.3-70b-instruct');
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
    const conflict = compareReference(model({ contextWindow: 16000, inputModalities: ['text'] }), entry);
    expect(conflict.contextConflict).toBe(true);
    expect(conflict.modalityConflict).toBe(true);
    expect(conflict.conflictCount).toBe(0);

    const uncovered = compareReference(model({ contextWindow: 16000, inputModalities: ['text'] }), { id: 'x/y', inputModalities: ['text'], reasoningLevels: [] });
    expect(uncovered.contextConflict).toBe(false);
    expect(uncovered.modalityConflict).toBe(false);
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
});
