import { describe, expect, it } from 'vitest';
import { ollamaAdapter } from './ollama';
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
});
