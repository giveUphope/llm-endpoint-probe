import { describe, expect, it } from 'vitest';
import { createProfile } from './profile';
import { detectProvider, resolveProviderProfile } from './providers';

describe('provider presets', () => {
  it('recognizes OpenRouter URLs with or without a trailing slash', () => {
    expect(detectProvider('https://openrouter.ai/api/v1/')?.id).toBe('openrouter');
    expect(detectProvider('https://eu.openrouter.ai/api/v1')?.id).toBe('openrouter');
  });

  it('automatically resolves provider authentication without replacing the API key or URL', () => {
    const profile = { ...createProfile(), apiKey: 'secret', baseURL: 'https://api.anthropic.com/v1' };
    expect(resolveProviderProfile(profile).profile).toMatchObject({
      baseURL: 'https://api.anthropic.com/v1', apiKey: 'secret', protocol: 'anthropic', authMode: 'custom', customHeaderName: 'x-api-key',
    });
  });

  it.each([
    ['https://api.openai.com/v1', 'openai'],
    ['https://generativelanguage.googleapis.com/v1beta', 'gemini'],
    ['https://api.cohere.com', 'cohere'],
    ['https://api.mistral.ai/v1', 'mistral'],
    ['https://api.groq.com/openai/v1', 'groq'],
    ['https://api.together.ai/v1', 'together'],
    ['https://api.deepseek.com', 'deepseek'],
    ['https://api.x.ai/v1', 'xai'],
    ['https://sample.openai.azure.com/openai/v1', 'azure-openai'],
    ['https://bedrock-runtime.us-east-1.amazonaws.com/v1', 'bedrock'],
    ['https://us-central1-aiplatform.googleapis.com/v1beta1/projects/p/locations/l/endpoints/openapi', 'vertex-ai'],
  ])('recognizes %s as %s', (url, id) => {
    expect(detectProvider(url)?.id).toBe(id);
  });

  it('replaces stale client protocol and authentication choices on every resolution', () => {
    const profile = { ...createProfile(), baseURL: 'https://api.cohere.com/v2', protocol: 'manual' as const, authMode: 'custom' as const };
    expect(resolveProviderProfile(profile).profile).toMatchObject({ name: 'Cohere', protocol: 'cohere', authMode: 'bearer' });
  });

  it.each([
    ['https://api.openai.com/v1/chat/completions', 'https://api.openai.com/v1', 'openai-chat', 'bearer', 'OpenAI'],
    ['https://api.openai.com/v1/responses?stream=true', 'https://api.openai.com/v1', 'openai-responses', 'bearer', 'OpenAI'],
    ['https://api.anthropic.com/v1/messages', 'https://api.anthropic.com/v1', 'anthropic', 'custom', 'Anthropic'],
    ['https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent', 'https://generativelanguage.googleapis.com/v1beta', 'gemini', 'custom', 'Google Gemini'],
    ['https://api.cohere.com/v2/chat', 'https://api.cohere.com', 'cohere', 'bearer', 'Cohere'],
    ['http://localhost:11434/api/chat', 'http://localhost:11434', 'ollama', 'none', 'localhost:11434'],
    ['https://gateway.example.com/custom/v1/chat/completions', 'https://gateway.example.com/custom/v1', 'openai-chat', 'bearer', 'gateway.example.com/custom/v1'],
  ])('resolves full request URL %s', (input, baseURL, protocol, authMode, name) => {
    expect(resolveProviderProfile({ ...createProfile(), baseURL: input }).profile).toMatchObject({ baseURL, protocol, authMode, name });
  });
});
