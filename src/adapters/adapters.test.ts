import { describe, expect, it } from 'vitest';
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
    expect(geminiAdapter.buildValidationRequest(model.id, 'supportsStreaming')?.path).toBe('/models/gemini-test:streamGenerateContent?alt=sse');
    expect(geminiAdapter.buildValidationRequest(model.id, 'supportsTools')?.body).toMatchObject({ toolConfig: { functionCallingConfig: { mode: 'ANY' } } });
  });

  it('parses Cohere models across its v1 catalog and v2 chat endpoints', () => {
    const payload = { models: [{ name: 'command-test', context_length: 128000, endpoints: ['chat', 'embed'] }] };
    expect(cohereAdapter.recognizes(payload)).toBe(true);
    const [model] = cohereAdapter.parseModels(payload);
    expect(model).toMatchObject({ id: 'command-test', contextWindow: 128000, protocol: 'cohere', supportedEndpoints: ['/v2/chat', '/v2/embed'] });
    expect(cohereAdapter.buildValidationRequest(model.id, 'supportsTopP')).toMatchObject({ path: '/v2/chat', body: { p: 1 } });
  });
});
