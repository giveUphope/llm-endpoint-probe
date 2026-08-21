import type { AdapterRequest } from '../domain/types';
import { describe, expect, it } from 'vitest';
import { buildGenerationProbe, classifyGenerationShape, extractEchoedModel, imageConsistencyFlags, sameModelName } from './shared';
import { ollamaAdapter } from './ollama';
import { cohereAdapter } from './cohere';
import { geminiAdapter } from './gemini';
import { openAIAdapter, simpleArrayAdapter } from './openai';

describe('protocol adapters', () => {
  it('parses OpenAI data arrays and catalog fields', () => {
    const payload = { data: [{ id: 'gpt-test', display_name: 'GPT Test', context_window: 128000, max_output_tokens: 8192, input_modalities: ['text', 'image'] }] };
    expect(openAIAdapter.recognizes(payload)).toBe(true);
    const [model] = openAIAdapter.parseModels(payload);
    expect(model).toMatchObject({ id: 'gpt-test', displayName: 'GPT Test', contextWindow: 128000, maxOutputTokens: 8192, inputModalities: ['text', 'image'] });
    expect(model.rawMetadata).toEqual(payload.data[0]);
  });

  it('parses Ollama tags and nested details', () => {
    const payload = { models: [{ name: 'qwen3:8b', model: 'qwen3:8b', details: { family: 'qwen3', num_ctx: 32768 } }] };
    expect(ollamaAdapter.recognizes(payload)).toBe(true);
    const [model] = ollamaAdapter.parseModels(payload);
    expect(model.id).toBe('qwen3:8b');
    expect(model.contextWindow).toBe(32768);
    expect(model.supportedEndpoints).toContain('/api/chat');
  });

  it('parses a simple model array', () => {
    const [model] = simpleArrayAdapter.parseModels([{ name: 'local-model', max_tokens: '4096' }]);
    expect(model.id).toBe('local-model');
    expect(model.maxOutputTokens).toBe(4096);
  });

  it('normalizes OpenRouter nested metadata and supported parameters', () => {
    const [model] = openAIAdapter.parseModels({ data: [{
      id: 'provider/multimodal-model',
      context_length: 262144,
      architecture: { input_modalities: ['text', 'image', 'video'] },
      top_provider: { max_completion_tokens: 131072 },
      pricing: { input_cache_read: '0.0000001' },
      reasoning: { supported_efforts: ['low', 'high'] },
      supported_parameters: ['tools', 'response_format', 'structured_outputs', 'reasoning', 'temperature', 'top_p', 'stop', 'seed'],
    }] });
    expect(model).toMatchObject({ contextWindow: 262144, maxOutputTokens: 131072, inputModalities: ['text', 'image', 'video'], reasoningLevels: ['low', 'high'] });
    expect(model.capabilities.supportsTools.value).toBe('supported');
    expect(model.capabilities.supportsStructuredOutput.value).toBe('supported');
    expect(model.capabilities.supportsReasoning.evidence[0]).toMatchObject({ source: 'endpoint', confidence: 'medium' });
    expect(model.capabilities.supportsStreaming.value).toBe('unknown');
    expect(model.capabilities.supportsPromptCache.value).toBe('inferred');
  });

  it('parses Gemini model metadata and builds native validation requests', () => {
    const payload = { models: [{
      name: 'models/gemini-test', displayName: 'Gemini Test', inputTokenLimit: 1048576, outputTokenLimit: 8192,
      supportedGenerationMethods: ['generateContent', 'streamGenerateContent'], thinking: true, temperature: 1, topP: 0.95,
    }] };
    expect(geminiAdapter.recognizes(payload)).toBe(true);
    const [model] = geminiAdapter.parseModels(payload);
    expect(model).toMatchObject({ id: 'gemini-test', displayName: 'Gemini Test', contextWindow: 1048576, maxOutputTokens: 8192, protocol: 'gemini' });
    expect(model.capabilities.supportsReasoning.value).toBe('supported');
    expect((geminiAdapter.buildValidationRequest(model.id, 'supportsStreaming') as AdapterRequest)?.path).toBe('/models/gemini-test:streamGenerateContent?alt=sse');
    expect((geminiAdapter.buildValidationRequest(model.id, 'supportsTools') as AdapterRequest)?.body).toMatchObject({ toolConfig: { functionCallingConfig: { mode: 'ANY' } } });
  });

  it('parses Cohere models across its v1 catalog and v2 chat endpoints', () => {
    const payload = { models: [{ name: 'command-test', context_length: 128000, endpoints: ['chat', 'embed'] }] };
    expect(cohereAdapter.recognizes(payload)).toBe(true);
    const [model] = cohereAdapter.parseModels(payload);
    expect(model).toMatchObject({ id: 'command-test', contextWindow: 128000, protocol: 'cohere', supportedEndpoints: ['/v2/chat', '/v2/embed'] });
    expect(cohereAdapter.buildValidationRequest(model.id, 'supportsTopP')).toEqual([
      { method: 'POST', path: '/v2/chat', body: expect.objectContaining({ p: 1 }) },
      { method: 'POST', path: '/v2/chat', body: expect.objectContaining({ p: 0.01 }) },
    ]);
  });

  it('extracts the echoed model name across OpenAI, Cohere, Ollama and Gemini shapes', () => {
    expect(extractEchoedModel({ model: 'gpt-4o', choices: [] })).toBe('gpt-4o');
    expect(extractEchoedModel({ modelVersion: 'gemini-2.5-flash-001' })).toBe('gemini-2.5-flash-001');
    expect(extractEchoedModel({ choices: [{ model: 'relay-model-echo' }] })).toBe('relay-model-echo');
    expect(extractEchoedModel({ choices: [{ message: { content: 'ok', model: 'nested-model-echo' } }] })).toBe('nested-model-echo');
    expect(extractEchoedModel({ model: '', choices: [{ model: 'fallback-echo' }] })).toBe('fallback-echo');
    expect(extractEchoedModel({ choices: [], model: '' })).toBeUndefined();
    expect(extractEchoedModel('data: {"model":"ollama-fake"}')).toBeUndefined();
  });

  it('parses relay catalog endpoint types and vendor metadata', () => {
    const [model] = openAIAdapter.parseModels({ data: [{
      id: 'claude-sonnet-4-5', vendor_name: 'Claude', supported_endpoint_types: ['anthropic', 'openai'],
    }] });
    expect(model).toMatchObject({ vendor: 'Claude', endpointTypes: ['anthropic', 'openai'] });
    const [fallback] = openAIAdapter.parseModels({ data: [{ id: 'deepseek-r1', owned_by: 'deepseek' }] });
    expect(fallback.vendor).toBe('deepseek');
  });

  it('treats versioned echo names as the same model without over-matching', () => {
    expect(sameModelName('gemini-2.5-flash', 'gemini-2.5-flash-001')).toBe(true);
    expect(sameModelName('gemini-2.5-flash', 'gemini-2.5-flash-2024-08-06')).toBe(true);
    expect(sameModelName('my-fake-model', 'gpt-4o')).toBe(false);
    expect(sameModelName('gpt-4o', 'gpt-4o-mini')).toBe(false);
    expect(sameModelName('llama-3', 'llama-3-8b')).toBe(false);
    expect(sameModelName('qwen-2.5', 'qwen-2.5-coder')).toBe(false);
    expect(sameModelName('gpt-4', 'gpt-4-turbo')).toBe(false);
  });

  it('builds minimal generation probes for image, video and music interfaces', () => {
    expect(buildGenerationProbe('image-generation', 'flux-pro')?.path).toBe('/images/generations');
    expect(buildGenerationProbe('image-generation', 'flux-pro')?.body).toMatchObject({ model: 'flux-pro', n: 1, size: '256x256' });
    expect(buildGenerationProbe('openai-video', 'veo3-pro')?.path).toBe('/videos/generations');
    expect(buildGenerationProbe('openai-video', 'veo3-pro')?.body).toMatchObject({ model: 'veo3-pro' });
    expect(buildGenerationProbe('music', 'suno-v3')?.path).toBe('/music/generations');
    expect(buildGenerationProbe('doubao', 'x')).toBeNull();
  });

  it('fingerprints generation response shapes across upstream families', () => {
    expect(classifyGenerationShape({ created: 1, data: [{ url: 'https://x/1.png' }] })).toMatchObject({ family: 'openai-images', imageCount: 1 });
    expect(classifyGenerationShape({ created: 1, data: [{ b64_json: 'A'.repeat(400_000) }] })).toMatchObject({ family: 'openai-images', b64Length: 400_000 });
    expect(classifyGenerationShape({ id: 'task-1', status: 'queued' })).toMatchObject({ family: 'async-task', taskStatus: 'queued' });
    expect(classifyGenerationShape({ images: ['https://x/1.png'] })).toMatchObject({ family: 'image-array' });
    expect(classifyGenerationShape({ output: ['https://x/1.png'] })).toMatchObject({ family: 'output-array' });
    expect(classifyGenerationShape({ status: 'running' })).toMatchObject({ family: 'status-only' });
    expect(classifyGenerationShape('data: {"ok":1}')).toMatchObject({ family: 'text' });
    expect(classifyGenerationShape({ foo: 1 })).toMatchObject({ family: 'unknown' });
  });

  it('derives minimal-parameter honoring flags from the image shape', () => {
    expect(imageConsistencyFlags({ family: 'openai-images', label: 'x', imageCount: 1, b64Length: 20_000 })).toEqual({ nHonored: true, sizeHonored: true });
    expect(imageConsistencyFlags({ family: 'openai-images', label: 'x', imageCount: 3 })).toEqual({ nHonored: false });
    expect(imageConsistencyFlags({ family: 'openai-images', label: 'x', b64Length: 400_000 })).toEqual({ sizeHonored: false });
    expect(imageConsistencyFlags({ family: 'async-task', label: 'x' })).toEqual({});
  });
});
